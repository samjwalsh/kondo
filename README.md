# Kondo

Keeps a Plex media server tidy. One web app made of **tools**; the first one
transcodes the library to H.265 (replacing a nightly cron script), choosing which
audio and subtitle tracks to keep, and only swapping files when nobody is watching.

Status: early — the web app skeleton and deploy pipeline exist; tools come next.
See [DESIGN.md](DESIGN.md) for how it works and the build plan.

## Develop

Requires Node 24+.

```sh
npm install
npm run dev:server   # API on http://localhost:4242
npm run dev:web      # UI on http://localhost:5173 (proxies /api to the server)
npm run check        # lint, type-check, tests
npm run build        # dist/server/main.mjs + dist/web/
```

## Deploy

Kondo runs as a user-level systemd service on the machine that runs Plex; no
Docker, no sudo for deploys, and it brings its own Node.

1. Key-based SSH to that machine, and lingering enabled for the user
   (`sudo loginctl enable-linger <user>`, once) so the service starts at boot.
2. `cp deploy/deploy.env.example deploy/deploy.env` and fill it in.
3. `npm run deploy` — checks, builds, uploads a new release, switches to it,
   restarts the service and confirms it's answering. The last five releases
   are kept on the machine.

Settings live in `~/kondo/config/kondo.env` on that machine.

## License

MIT
