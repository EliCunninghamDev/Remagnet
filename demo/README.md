# Remagnet demo clip

Reproducible recording of the Chrome flow used on the project's GitHub page:
right-click a magnet link, pick **Add to Remagnet**, review it in the popover,
and send it to qBittorrent.

The clip is recorded with `web-demo-mcp` against the real extension. A small
in-memory server (`mock-qbittorrent.ts`) stands in for the qBittorrent Web API,
so the demo needs no network access, no torrent client, and never shows a
personal URL or torrent.

| File                  | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `page/index.html`     | Fictional mirror page with one magnet link and one HTTP link    |
| `mock-qbittorrent.ts` | In-memory qBittorrent Web API v2 with one existing torrent      |
| `prepare-addon.mjs`   | Copies the Chrome build, grants the mock origin, seeds settings |
| `remagnet.yaml`       | The recorded steps and camera path                              |
| `assets/*.png`        | Image targets for the native popover (OCR is unreliable there)  |

## Record it

Requirements: Linux with X11, `Xvfb`, `xdotool`, `ffmpeg`, `tesseract`, Bun, and
a `web-demo-mcp` checkout with its Python dependencies installed.

```bash
# From the repository root:
WEB_DEMO_MCP=/path/to/web-demo-mcp/.venv/bin/web-demo-mcp demo/run.sh
```

Outputs land in `demo/out/` (`remagnet.gif`, `remagnet.mp4`, the raw recording,
event log, and screenshots). The script rebuilds the extension, starts a fresh
mock client on port 8099, and stops it afterwards.

To record against a different mock port, set `MOCK_QBIT_PORT` for both the
prepare step and the server. The image targets are captured at scale 2; if the
popover layout changes significantly, re-crop `assets/send-button.png` from a
fresh `out/screenshots/review.png`.

## Publishing

The GIF and MP4 used in the root README live in `docs/`:

- `docs/remagnet-demo.gif`
- `docs/remagnet-demo.mp4`
