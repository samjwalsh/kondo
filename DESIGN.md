# Kondo — design

Kondo tidies the media server. It is one web app made of **tools**; the first tool
replaces Squish CRON (transcoding the library to H.265). More tools can be added
later without touching the others.

Status: reviewed by Sam 2026-10-26; decisions folded in (see [Decided](#decided)).

## Goals

- Replace Squish CRON with something that **can't silently stop working**
  (Squish sat on a stale lock file from 16 Oct and nobody knew).
- Shrink the library without losing anything people actually watch: English audio,
  original-language audio for foreign titles, English subtitles.
- Never break a stream, never corrupt a seeding torrent, survive power cuts.
- Make every destructive step visible first (approval mode / dry runs).
- Make adding a third or fourth tool a matter of adding one folder.

## Non-goals (for now)

- Torrent cleanup. qBittorrent already removes torrents + files at per-torrent
  limits set by Sonarr/Radarr (time-based, per tracker). Revisit only if
  that proves unreliable.
- Upgrading the Plex VM (Ubuntu 20.04, NVIDIA 470). Kondo must work as it is.
- 4K / HDR / Dolby Vision transcoding.

## Environment (what the design has to fit)

| Thing | Fact | Consequence |
|---|---|---|
| Host | Plex VM on the LAN, Ubuntu 20.04, 32 vCPU, 11 GB RAM, unprivileged user | Kondo runs here as a systemd service next to Plex |
| GPU | GTX 1050 2 GB, driver 470 (GeForce: max 3 NVENC sessions) | One GPU job at a time, leaving sessions for Plex |
| Tools | ffmpeg 4.2.7 (hevc_nvenc, libx265, eac3), ffprobe; HandBrake 1.3.3 | Use the existing ffmpeg — newer builds may need a newer driver |
| Node | System Node 18 (EOL) | Kondo ships its own Node 24 under its install dir; system untouched |
| Media | `/mnt/plexdrive` over 9p from Unraid, 777, ~6,243 videos / 5.9 TB | Full metadata walk takes ~27 s; no inotify, so no file-change events |
| Torrents | `/mnt/plexdrive/temp`, **hardlinked** into the library by Sonarr/Radarr | Never modify a library file in place; replacing/renaming is safe |
| Backlog | 599 files / 2.86 TB not yet transcoded (Squish stuck); 5,644 `[SQUISH]` files | Big first win; the tidy-up renames the `[SQUISH]` files |
| Services | Plex on the same VM; Sonarr, Radarr, Bazarr in containers on Unraid | Integrations over their HTTP APIs |

## Architecture

```
kondo (one Node process, systemd, port 4242)
├─ core/
│   ├─ server        HTTP API + serves the web UI; server-sent events for live updates
│   ├─ tools         registry: discovers tools/*, mounts their routes, jobs and pages
│   ├─ jobs          persistent job queue with resource slots (gpu, cpu), progress, logs
│   ├─ scheduler     cron-style schedules + time windows + "pause while Plex is busy"
│   ├─ settings      per-tool settings validated by schemas; secrets kept separately
│   ├─ db            SQLite (one file), migrations per tool
│   ├─ notify        Telegram messages; Uptime Kuma heartbeat
│   └─ health        stuck-job detection, missed-window detection, self-checks
├─ integrations/     shared API clients: plex, sonarr, radarr, bazarr (later: qbittorrent)
└─ tools/
    └─ transcode/    the Squish replacement (below)
```

### What a tool is

A folder under `src/tools/<id>/` (`server.ts`, `web.tsx`, `shared.ts`), registered
with one line in `src/tools/server.ts` and one in `src/tools/web.ts`. The server
part exports one object:

```ts
export default defineTool({
  id: "transcode",
  name: "Transcode",
  settings: schema,                      // validated, edited in the UI
  migrations,                            // its own tables
  register(ctx) {                        // ctx: db, jobs, scheduler, integrations, notify, log, events
    ctx.jobs.define("encode", { slot: "gpu" | "cpu", run });
    ctx.scheduler.every("1h", scanLibrary);
    ctx.routes((r) => { /* /api/tools/transcode/... */ });
  },
  status: () => ({ /* dashboard card: health, counts, next run */ }),
  ui: { page, card },                    // React page + dashboard card
});
```

The core never knows tool internals; a new tool gets jobs, schedules, settings,
storage, notifications and a page for free.

### Reliability: "it can't silently stop"

- systemd restarts the process if it dies; there is no lock file to go stale
  (one process owns the queue; job state lives in SQLite).
- **Health checks** raise a Telegram alert when: a job makes no progress for 30 min,
  a night window passes with work queued but nothing done, an integration stops
  answering, or the disk is nearly full.
- **Heartbeat**: Kondo pings an Uptime Kuma push monitor on the VPS every few
  minutes while healthy. If Kondo dies, hangs or the VM is off, the VPS alerts.

## Transcode tool

### Pipeline

```
discover → probe → decide → (queue) → encode → verify → approve → swap → notify
```

1. **Discover**
   - Sonarr/Radarr *On Import / On Upgrade* webhooks add files immediately
     (they only queue — nothing runs until the window).
   - A scan walks the library roots hourly (cheap: ~27 s) and probes only
     files that are new or whose size/mtime changed. This is the safety net that
     catches any H.264 file however it arrived.
   - Library roots are a setting, defaulting to `/mnt/plexdrive/TV` and
     `/mnt/plexdrive/Movies`. Nothing outside the roots is ever touched (no `Ed`,
     `Books`, `Music`, ...). `/mnt/plexdrive/temp` is hard-excluded even if someone
     adds it as a root.
2. **Probe** with ffprobe; cache the result keyed by path + size + mtime.
3. **Decide** (source of truth is the file itself, not its name):
   - Kondo tag present → already done, skip.
   - H.264, MPEG-2, VC-1, MPEG-4/Xvid, WMV → candidate.
   - H.265/AV1 → candidate only if its video bitrate is above the re-encode
     threshold for its resolution (see [Quality target](#quality-target)).
   - Skip: HDR/Dolby Vision, > 1080p, no video, damaged files (with a reason).
   - Remembered decisions (skipped, failed, not worth it) aren't retried unless
     the file changes.
4. **Queue** ordered by expected space saved.
5. **Encode** to a hidden temp file in the same folder:
   `.<name>.kondo-<job>.mkv` (same filesystem → atomic swap later).
6. **Verify**: duration within max(1 s, 0.5 %); expected streams present; video is
   HEVC; three short decode checks (start/middle/end); result ≤ 80 % of the
   original's size (otherwise "not worth it": temp deleted, original kept).
7. **Approve**: in approval mode the job waits with a summary (tracks kept /
   dropped, size before → after, encoder, a link to compare). Approve or reject,
   singly or in bulk. Later: automatic mode.
8. **Swap** (see below), then ask Plex to rescan that folder and Sonarr/Radarr to
   rescan the series/movie.

### Track rules

Original language comes from Sonarr/Radarr, so "foreign film" doesn't depend on
track tags.

| Track | Keep | Drop | Convert |
|---|---|---|---|
| Video | main video stream | cover-art images | → H.265 (8-bit or 10-bit to match source) |
| Audio | English; untagged; original language; **always** the default track | commentary; audio description | lossless (TrueHD, DTS-HD, FLAC, PCM) and DTS → E-AC3 (5.1 @ 640k, stereo @ 224k; 7.1 → 5.1). AC3/E-AC3/AAC/Opus copied as-is |
| Subtitles | English (incl. SDH and forced); untagged; forced in any language | other languages | MP4 `mov_text` → SRT (MKV can't hold it); everything else copied |
| Other | chapters; font attachments when styled (ASS) subs are kept | — | — |

If the rules would leave no audio track, keep the default and first tracks.
Foreign film with no English subtitles: fine, transcode anyway.

Known trade-off: Atmos inside TrueHD is lost when converting to E-AC3.

### Encoders and slots

| Slot | Encoder | Why | Limits |
|---|---|---|---|
| `gpu` | `hevc_nvenc` on the 1050 (hardware decode where possible) | fast — the backlog workhorse | 1 job; pauses while Plex is transcoding |
| `cpu` | `libx265` | smaller files at the same quality, slower | 1 job, capped threads (e.g. 16 of 32), lowest priority (`nice`) |

- Encoders sit behind one interface (`canHandle`, `buildArgs`, `parseProgress`), so
  another one (e.g. VAAPI on the RX 5700 XT) can be added later.
- The CPU slot prefers the biggest high-bitrate files (where x265's efficiency
  pays most); the GPU slot takes the next file in the queue.
- Rough backlog estimate: with both slots, ~1–2 weeks of nights for the ~545
  H.264 files, less with idle mode.

### Quality target

Reference = Squish's `H265.json`: NVENC H.265, constant quality 32, preset `hq`,
variable frame rate, black bars auto-cropped, source resolution, no
denoise/sharpen. Measured on 265 sampled 1080p `[SQUISH]` TV files, that gives a
video bitrate of p10 0.9 · median **1.5** · p90 2.4 · max 3.5 Mb/s.

- **GPU slot** reproduces those settings with ffmpeg's `hevc_nvenc` (constant
  quality 32, high-quality preset, look-ahead, crop detection). First approval-mode
  files are compared against `[SQUISH]` output of similar episodes.
- **CPU slot** (x265) is calibrated to the *same visual quality*, not the same
  number: on a few sample files, pick the x265 CRF whose SSIM against the source
  matches what NVENC CQ 32 achieves, then compare sizes.
- **Re-encode thresholds** for files that are already H.265/AV1 (video bitrate):

  | Resolution | Re-encode above | Why |
  |---|---|---|
  | 1080p | 3.5 Mb/s | higher than any sampled Squish output |
  | 720p | 1.6 Mb/s | scaled by pixel count |
  | SD | 0.8 Mb/s | scaled by pixel count |
  | > 1080p | never (v1) | out of scope |

  The 54 H.265 files in the current backlog sit at ~1.3 Mb/s, so they're skipped.
- Every result must still be ≥ 20 % smaller than the original, or it's discarded.
- Audio is bigger than Squish's (E-AC3 5.1 640k instead of AAC stereo 128k),
  by Sam's choice; video settings stay at Squish's level.

### Schedule and idle mode

- **Night window 02:00–08:00**: both slots run. The GPU slot pauses while Plex is
  transcoding video (the 1050 has one encoder chip, and live streams come first);
  the CPU slot runs at lowest priority and pauses while Plex is transcoding on the
  CPU.
- **Idle mode (outside the window, opt-in)**: a job may only start after Plex has
  had no sessions at all for 15 minutes. The moment anyone starts playing anything,
  every running encode is frozen (paused in place, using no CPU or GPU) and resumes
  after another 15 quiet minutes. Nothing is lost by pausing.
- Plex activity comes from Plex's live notification stream (near-instant), with
  polling every 10 s as a fallback; if Plex can't be reached, Kondo assumes it is
  busy.
- A frozen GPU encode still holds one of the 1050's three encoder sessions; Plex
  keeps two, and falls back to the CPU beyond that.
- Swaps are independent of the window: any time, as long as nobody is playing
  that file.

### Safety rules

- **Never edit a library file in place.** Library files are hardlinks of seeding
  torrents; editing one would change the torrent's data. Kondo only creates new
  files, renames and unlinks — all safe for the torrent's own copy.
- Never touch `/mnt/plexdrive/temp`.
- Keep original file names (Squish's `[SQUISH]` suffix orphaned Bazarr's `.srt`
  files). Only the extension may change (e.g. `.mp4` → `.mkv`).
- Kondo's outputs carry invisible MKV tags (`KONDO_VERSION`, encoder, settings,
  source codec/size, date) so it recognises its work without the database.

### Swap and crash recovery

Each step is recorded in SQLite before it happens:

1. Ask Plex for active sessions; if anyone is playing (or paused on) this file,
   wait and retry later.
2. Record `SWAPPING` (source, temp, final paths).
3. `rename(temp → final)` — atomic. Same name (mkv → mkv): the episode is never
   missing, even for an instant.
4. If the name changed (mp4 → mkv), unlink the source.
5. Record `DONE`; trigger Plex + Sonarr/Radarr rescans.

On start-up Kondo finishes or rolls back anything left mid-way:
`ENCODING` → delete the temp file, requeue; `VERIFIED`/`AWAITING_APPROVAL` →
re-verify; `SWAPPING` → inspect what's on disk (tagged final present? source
present?) and complete the remaining step. Stray `.kondo-*` temp files with no job
are cleaned up.

### One-off tidy of `[SQUISH]` files

A separate action with a dry-run list first:

- Rename `X [SQUISH].mkv` → `X.mkv` (and matching `X [SQUISH].*.srt` sidecars)
  when the target name is free; conflicts are listed, not touched.
- Work one series/movie at a time: rename all its files, then ask Sonarr/Radarr
  to rescan that series/movie, so the old and new names are seen in the same scan
  and the episode never looks "missing" (which could trigger a re-download).
  Then a Plex rescan of that folder. Watch history stays with the episode.
- Bazarr's orphaned `X.*.srt` files re-attach automatically because the names
  match again.
- Record each file in Kondo's database as `legacy-squish`, but **don't write the
  Kondo tag into them**: that would mean editing 5,644 files (3 TB) in place or
  copying them all, for no gain — they're H.265 below the re-encode threshold, so
  the decide step skips them even if the database were lost. (Squish already
  stripped their subtitles and extra audio; that can't be undone.)

## UI

- **Dashboard**: one card per tool (health, what's running, next window, warnings).
- **Transcode**: live queue (per slot, with progress and ETA) · awaiting approval ·
  library overview (by codec/status, potential savings, skipped with reasons) ·
  history (space saved over time) · settings.
- **System**: integrations (URLs, tokens — write-only, with a "test connection"
  button), notifications, logs.

Access: Kondo's own subdomain through the existing reverse proxy (Nginx Proxy
Manager) with forward authentication in front, like the other services. Direct
access on the LAN port is deliberately left open (trusted network).
Sonarr/Radarr webhooks call the VM directly on the LAN with a shared secret.

## Stack (proposal)

- TypeScript throughout; Node 24 LTS installed privately under `/opt/kondo/node`.
- Fastify (HTTP, plugins map well onto tools); React + Vite for the UI; server-sent
  events for live progress.
- SQLite via Node's built-in `node:sqlite` — no native modules to compile on the
  old VM.
- Vitest. Decision/track rules tested against real ffprobe output captured from the
  library; end-to-end tests on small generated videos with multiple audio/subtitle
  tracks.
- Deploy: `npm run deploy` builds on the desktop, copies to the VM over SSH and
  restarts the systemd unit. The GitHub repo runs type-check + tests on push.

## Build plan

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold + deploy pipeline | "Hello" page live on its subdomain, deployed by one command |
| M1 | Core | tools registry, settings, integrations with connection tests, job queue + slots, scheduler/windows, live UI, Telegram, Kuma heartbeat, health checks |
| M2 | Transcode, read-only | Library page shows exactly what Kondo *would* do to every file (whole-library dry run) |
| M3 | Encode + verify + approval (GPU) | First real files transcoded into temp files, approved by Sam — on a sandbox folder first |
| M4 | Swap + recovery | Approved files swapped safely; power-cut recovery tested; Squish's cron removed |
| M5 | CPU slot | Both encoders running; quality calibrated side by side |
| M6 | `[SQUISH]` tidy | Dry run reviewed, renames done in batches |
| M7 | Automatic mode | Approval switched off once trusted |

Later, if wanted: torrent tool; RX 5700 XT encoder; VM upgrade.

## Decided

- Library roots: TV and Movies only (configurable); `Ed` and everything else excluded.
- Night window 02:00–08:00, plus idle mode under the rules above.
- Quality = Squish's H265.json; thresholds from measured `[SQUISH]` output.
- `[SQUISH]` tidy renames only; no in-place tagging.
- Address: its own subdomain behind the reverse proxy and forward auth.
- Still to calibrate on real files: the x265 CRF (M5).
