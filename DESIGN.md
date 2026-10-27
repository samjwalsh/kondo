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
5. **Encode** into Kondo's own work folder on the VM's disk (not the library), so
   results waiting for approval never sit in the library and a crash can't leave
   half-written files there. Black bars are cropped only when six sample points
   agree.
6. **Verify**: duration within max(1 s, 0.5 %); expected streams present; video is
   HEVC; three short decode checks (start/middle/end); result ≤ 80 % of the
   original's size (otherwise "not worth it": temp deleted, original kept).
7. **Approve**: in approval mode the result waits with a summary (size before →
   after, checks, encoder speed) and two comparison frames (original vs Kondo at
   the same moment). Approve or reject; rejecting (or cancelling an encode) means
   the file isn't offered again. At most 10 results are waiting or in progress at
   once, so the work folder can't fill the disk. Later: automatic mode.
8. **Swap** (see below), then ask Plex to rescan that folder and Sonarr/Radarr to
   rescan the series/movie.

### Track rules

Original language comes from Sonarr/Radarr, so "foreign film" doesn't depend on
track tags.

| Track | Keep | Drop | Convert |
|---|---|---|---|
| Video | main video stream | cover-art images | → H.265 (8-bit or 10-bit to match source) |
| Audio | English; untagged; original language — **one track per language**, the best (most channels, then best source); all untagged tracks | commentary; audio description; other languages; extra tracks in a language already kept (e.g. an AC3 copy of a TrueHD mix) | lossless (TrueHD, DTS-HD, FLAC, PCM) and DTS → E-AC3 (5.1 @ 640k, stereo @ 224k; 7.1 → 5.1). AC3/E-AC3/AAC/Opus copied as-is |
| Subtitles | English (incl. SDH and forced); untagged | other languages, including their forced subtitles (those are for that language's speakers) | MP4 `mov_text` → SRT (MKV can't hold it); everything else copied |
| Other | chapters; font attachments when styled (ASS) subs are kept | — | — |

If the rules would leave no audio track, keep the default and first tracks.

Missing language tags: if a track's title names a language ("English [CC]"), that
language is used and written into the new file. A lone unlabelled audio track in a
title whose original language is known gets that language written in, so players
label and pick it properly.
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
  number. The calibration job takes a 60 s clip (at 40 %) from typical files still
  to transcode (high, median and low bitrate 1080p; a 720p and an SD if there are
  any; sizes judged by width so cropped films count as 1080p), encodes it
  with NVENC CQ 32 and with x265 at CRF 22/25/28/31, and measures each against the
  original with SSIM. It recommends the highest CRF (in half steps, rounded down)
  whose average SSIM still matches NVENC's, and reports the size difference and
  speed there. The CPU slot stays unused until a CRF is set. Result on this
  library (Oct 2026, medium preset): CRF 25, files 28 % smaller than NVENC's, about
  2× real time. The job has no page of its own (it's a one-off); it can be run
  again with `POST /api/tools/transcode/calibration`.
- Each encoder has at most one file queued, so files go to whichever frees up
  first; when both are free the CPU gets the biggest saving.
- **Re-encode thresholds** for files that are already H.265/AV1 (video bitrate):

  | Resolution | Re-encode above | Why |
  |---|---|---|
  | 1080p | 4.5 Mb/s | above every Squish output in the library (max 4.2 Mb/s over 5,554 files) |
  | 720p | 1.6 Mb/s | Squish's 720p output tops out at 0.9 Mb/s |
  | SD | 0.8 Mb/s | Squish's SD output tops out at 0.5 Mb/s |
  | > 1080p | never (v1) | out of scope |

  First scan: Squish's own files are all below these, so they're never re-encoded;
  two other H.265 files (4.7 and 4.8 Mb/s) are.
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

Approving a result queues a **swap** job (general slot). Each step is recorded in
SQLite before it happens:

1. Check the original is exactly what was encoded (same size and modified time).
   If it changed (e.g. Sonarr upgraded it) or is gone, the result is thrown away
   and the next scan looks at the file again.
2. Ask Plex who's watching; if anyone is playing (or paused on) this file, or Plex
   can't be asked, wait and try again later (every 5 minutes).
3. Copy the result next to the original as a hidden temp file
   (`.<name>.kondo-<id>.mkv`, same filesystem as the original), check its size,
   and give it the original's permissions. Check Plex again.
4. Record `SWAPPING` (source, temp, final paths).
5. `rename(temp → final)` — atomic. Same name (mkv → mkv): the episode is never
   missing, even for an instant. A torrent hardlinked to the original keeps the
   original's data.
6. If the name changed (mp4 → mkv), unlink the source.
7. Record `DONE` (and the saving in a history table); point the file's row at the
   new file so the next scan reads it afresh; delete the work folder; ask Plex to
   rescan the folder and Sonarr/Radarr to rescan the series/movie.

If a step before 4 fails, the temp file is removed and the result goes back to
waiting for approval with the reason shown. Cancelling a swap does the same.

Scans and swaps take turns (a lock), so a scan never sees a file half-swapped.

On start-up Kondo finishes or rolls back anything left mid-way:
`ENCODING` → delete the work folder, requeue; `SWAPPING` → inspect what's on disk
and complete the remaining step (temp present → rename; temp gone and the new file
in place → unlink the old name if needed; neither → nothing changed, back to
approved). Plex can't veto finishing a swap that's already part-done. Stray
`.kondo-*` temp files are removed by the next scan unless their swap is part-way.

### One-off tidy of `[SQUISH]` files

A separate action on the Transcode page, with a check (dry-run list) first:

- **Check** walks the library (skipping "never touch" folders) and lists every file
  with ` [SQUISH]` in its name, grouped by series/movie folder. Squish tagged
  subtitles, `.nfo`s and sample screenshots too, so all of them are included. A
  file whose plain name is already taken (e.g. Bazarr's old `X.en.srt` next to
  `X [SQUISH].en.srt`) is a clash: listed, never touched.
- **Rename** one title, or all of them one title at a time: rename its files, then
  ask Sonarr/Radarr to rescan that series/movie and Plex that folder, so the old and
  new names are seen in the same scan and the episode never looks "missing" (Sonarr
  only unmonitors a file that's still missing at the end of its rescan). A title
  with a file being watched is left for later. Scans, swaps and renames take turns.
- Bazarr's orphaned `X.*.srt` files re-attach automatically because the names
  match again. Watch history stays with the episode.
- Kondo moves its own record of each video to the new name (same size and time, so
  it isn't read again) and remembers an H.265 one as **done by Squish**: it is never
  re-encoded, even if the thresholds are lowered later. **Don't write the Kondo tag
  into them**: that would mean editing 5,600 files (3 TB) in place for no gain.
  A `[SQUISH]` name alone doesn't prove Squish encoded it (it renamed at least one
  H.264 file without encoding it), so only H.265 files count.

## Downloads tool (fake releases)

Fake releases on public trackers carry a program (`Episode.exe`, often with decoy videos in
a `vis/` folder) instead of the video. Sonarr/Radarr refuse to import them ("potentially
dangerous file") but don't mark them failed, so they never search again; the fake keeps
seeding and the episode stays missing.

Every 10 minutes the Downloads tool lists qBittorrent's torrents in the `sonarr`/`radarr`
categories and reads each one's file list (including files qBittorrent skips). A torrent
with a blocked file type (`exe scr com bat cmd msi lnk vbs`) is a fake. In **remove** mode
it finds the grab in Sonarr/Radarr's history by torrent hash, marks it failed (blocklist +
"Redownload Failed" search), and only then deletes the torrent and its files; if
Sonarr/Radarr can't be told, the torrent is left for the next check. **Report-only** mode
lists them without changing anything. Works whether or not the download is still in the
Sonarr/Radarr queue. Results go to the Downloads page, the dashboard card and the morning
summary (now a core feature that every tool adds lines to).

It checks every 2 minutes and reads the file list as soon as qBittorrent has the
torrent's metadata, so a fake is usually removed while it's still downloading. qBittorrent
itself downloads any file type (it's also used for software by hand); only the `sonarr` and
`radarr` categories are checked. Prevention outside Kondo: a 120-minute torrent delay profile
in Sonarr and Radarr (bypass for highest quality off), so RSS doesn't grab the first, often
fake, release.

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
| M7 | Automatic mode | Approval switched off once trusted (built straight after M4) |

Automatic mode approves every result that passes its checks (same length, the
planned tracks, decodes cleanly, at least the minimum saving), optionally at most N
swaps per rolling 24 hours. A result sent back after a failed swap still waits for a
person. The latest 50 swaps keep their comparison frames under "Recently replaced"
for spot checks after the fact.

Later, if wanted: torrent tool; RX 5700 XT encoder; VM upgrade.

## Decided

- Library roots: TV and Movies only (configurable); `Ed` and everything else excluded.
- Night window 02:00–08:00, plus idle mode under the rules above.
- Quality = Squish's H265.json; thresholds from measured `[SQUISH]` output.
- `[SQUISH]` tidy renames only; no in-place tagging.
- Address: its own subdomain behind the reverse proxy and forward auth.
- Still to calibrate on real files: the x265 CRF (M5).
