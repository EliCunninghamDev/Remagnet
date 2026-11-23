# Remagnet demo clip

Reproducible recording of the Chrome flow used on the project's GitHub page:
right-click a magnet link on The ISO Bay, pick **Add to Remagnet**, review it in
the popover, send it through the Remagnet Proxy to qBittorrent, then download
the finished torrent as a ZIP.

The clip is recorded with `web-demo-mcp` against the real extension. A small
in-memory server (`mock-proxy.ts`) implements the Remagnet Proxy API the
extension uses — health, torrent list/lookup/add/remove, single-use archive
tickets and `/archive/:hash` — so the demo needs no network access, no torrent
client, and never shows a personal URL or torrent. The demo addon fulfils the
final ZIP request inside the extension worker instead of saving a file, which
keeps Chrome's download bubble off the popover.

| File                | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `page/index.html`   | The ISO Bay, a fictional Linux ISO index with a magnet link    |
| `mock-proxy.ts`     | In-memory proxy API, device token, tickets, archive ZIP        |
| `prepare-addon.mjs` | Copies the build, grants the mock origin, seeds settings/token |
| `remagnet.yaml`     | The recorded steps and camera path                             |
| `assets/*.png`      | Image targets for the native popover (OCR is unreliable there) |

## Record it

Requirements: Linux with X11, `Xvfb`, `xdotool`, `ffmpeg`, `tesseract`, Bun, and
a `web-demo-mcp` checkout with its Python dependencies installed.

```bash
# From the repository root:
WEB_DEMO_MCP=/path/to/web-demo-mcp/.venv/bin/web-demo-mcp demo/run.sh
```

Outputs land in `demo/out/` (`remagnet.gif`, `remagnet.mp4`, the raw recording,
event log, and screenshots). The script rebuilds the extension, starts a fresh
mock proxy on port 8099, and stops it afterwards.

The mock accepts `remagnet-demo-token` as `Authorization: Bearer …`, matching the
real proxy's device token. Chrome mints a single-use ticket with
`POST /api/archive/:hash/ticket`, then requests the ZIP with `?ticket=…`;
Firefox sends the bearer token instead. `prepare-addon.mjs` seeds the URL and the
encrypted token into the copied addon, so the recording never shows the options
page. To record against a different port, set `MOCK_PROXY_PORT` for both the
prepare step and the server. The popover has no DOM hook, so the script frames
it with a fixed capture rect and clicks a button template. The completed row's
ZIP action is a fixed rect below that, because the newest torrent is always the
first row. Both are tied to the 1280x800 layout: re-measure `popover` and `zip`
in `remagnet.yaml` and re-crop `assets/send-button.png` from a fresh
`out/screenshots/review.png` if the popover moves or its design changes.

## Publishing

The GIF and MP4 used in the root README live in `docs/`:

- `docs/remagnet-demo.gif`
- `docs/remagnet-demo.mp4`
