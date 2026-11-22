<p align="center">
  <img src="docs/remagnet-banner.svg" alt="Remagnet: convenient torrent forwarding and download proxy" width="100%">
</p>

# Remagnet

[![CI](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml/badge.svg)](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A torrent forwarding and download proxy for Firefox, Chrome, and Android.

Firefox handles magnet links through a `magnet:` protocol handler. Chrome adds a
context menu item on magnet links. The Android client is being built around a
system-wide link handler.

Remagnet talks to your torrent client directly with an API key, or through a
token-secured proxy that zips completed torrents. Android client onboarding uses
a QR code.

<p align="center">
  <img src="docs/remagnet-demo.gif" alt="Right-clicking a magnet link on The ISO Bay in Chrome, sending it to qBittorrent through Remagnet, then downloading the finished torrent as a ZIP" width="800">
</p>

<p align="center"><sub>
  Right-click a magnet link, review it, and send it to the client.
  Chrome is shown; in Firefox a <code>magnet:</code> click opens the same popover.
</sub></p>

## Quick start

Remagnet has three pieces: the browser extension or Android app, qBittorrent,
and an optional **Remagnet Proxy**. The proxy is a small Docker service that
streams completed torrents to the client as ZIP files. Magnet forwarding works
without it; deploy it when you want the Download action.

### 1. Prepare qBittorrent

Enable the Web UI and generate an API key under **Preferences → Web UI → API
Key** (qBittorrent 5.2 or newer). Note the Web UI URL; Remagnet talks to
qBittorrent directly for everything except ZIP downloads.

### 2. Deploy Remagnet Proxy

Create a directory on the Docker host and add `compose.yaml`:

```yaml
services:
  remagnet-bridge:
    image: ghcr.io/elicunninghamdev/remagnet-bridge:latest
    container_name: remagnet-bridge
    restart: unless-stopped
    env_file: .env
    environment:
      DATA_DIR: /data
      BIND_ADDR: 0.0.0.0:8080
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "8080:8080"
    volumes:
      - remagnet-data:/data

volumes:
  remagnet-data:
```

Then create `.env` beside it:

```dotenv
# Generate with: openssl rand -hex 32
BRIDGE_TOKEN=replace-with-32-bytes-of-hex

# Where the proxy reaches qBittorrent's Web UI. If qBittorrent is another
# Compose service, use its service name and a shared network instead.
QBIT_BASE_URL=http://host.docker.internal:8080
QBIT_API_KEY=qbt_replace_with_your_key
```

Start the service:

```bash
docker compose pull
docker compose up -d
```

To build the image from this repository instead of pulling it:

```bash
git clone https://github.com/EliCunninghamDev/Remagnet.git
cd Remagnet/proxy
cp .env.example .env    # set BRIDGE_TOKEN and QBIT_* values
docker compose up -d --build
```

### 3. Configure the proxy

Open `http://<docker-host>:8080` and paste the same `BRIDGE_TOKEN`. That field
only unlocks the proxy's own settings page; it is not a second password. Point
the proxy at qBittorrent with the Web UI URL and API key, then choose **Test
connection**.

### 4. Connect Remagnet

In the extension's **Settings → Remagnet Proxy**, enter the proxy origin (for
example `https://remagnet.example.com`) and the same token. The Download action
on completed torrents stays disabled until both fields are saved.

For Android, open the **Remagnet Proxy** page (the URL you deployed in step 2)
and choose **Show QR code**, then scan it from the app. The phone claims a
one-time code from the proxy and receives the qBittorrent connection and proxy
token that are saved on the proxy server. The code rotates every minute and
works once, so keep it private. Pairing needs an HTTPS proxy origin; you can also
enter the values under **Settings**, or import a `remagnet://connect` code with
the QR scanner or paste box.

The same page's **Copy link** button produces a pairing link. Paste it into the
extension's **Remagnet Proxy → Pairing code** field to fill in the proxy URL,
token, and qBittorrent connection without typing them. A code is single-use, so
copy a fresh one for each device.

Expose the proxy over HTTPS before using it from another machine. A minimal
Caddy route for the Compose setup in this repository looks like:

```caddyfile
remagnet.example.com {
  reverse_proxy remagnet-bridge:8080
}
```

The proxy never stores torrent contents; it streams each completed file from
qBittorrent's Web API into the ZIP response.

## Layout

```
extension/            Firefox and Chrome extension (WXT, SolidJS)
proxy/                Rust/axum service, OpenAPI contract, ZIP streaming
android/              Android client (Kotlin, Jetpack Compose)
packages/
  qbittorrent/        Typed qBittorrent Web API v2 client
  proxy-client/       TypeScript client generated from the proxy contract
demo/                 Scripted demo recording
docs/                 Banner and demo media
scripts/              Client and banner generation
tokens.js             Design tokens (DTCG 2025.10)
```

## Development

```bash
bun install
bun run dev:firefox   # Firefox is the primary target
# bun run dev         # Chrome
```

Firefox starts with the extension installed and keeps its settings in
`extension/.dev/firefox-profile/`. On the options page, choose the client, enter
the qBittorrent Web UI URL and authentication, set the default category and
tags, then grant access to the qBittorrent origin. The popup shows only
torrents matching those defaults, so a shared qBittorrent instance does not
bury Remagnet's magnets under the rest of the library.

## OpenAPI Spec

[`proxy/openapi.yaml`](proxy/openapi.yaml) is the contract for every client that
speaks to the proxy. It is OpenAPI 3.1 and covers both authentication styles,
the config and health endpoints, the archive stream and each error status.

The TypeScript and Kotlin clients are generated from it, not maintained by hand:

- `packages/proxy-client`: types and an `openapi-fetch` wrapper for the
  extension.
- `android/proxy-client`: Retrofit sources with a streaming archive response.

```bash
bun run api:generate   # needs JDK 21; writes both clients
```

Commit the regenerated sources with any spec change so both builds stay
reproducible without running the generator.

## Design Tokens

[`tokens.js`](tokens.js) holds the visual system in the
[Design Tokens Community Group 2025.10 format](https://www.designtokens.org/tr/2025.10/format/):
light, dark and popup color schemes, type scale, spacing, layout dimensions and
motion. It is a plain ES module, so scripts import it directly, and
`JSON.stringify(tokens)` produces a valid `.tokens.json` document.

`extension/assets/app.css` mirrors the tokens for the extension pages;
`bun run test` checks the token structure and value types. The wordmark
(`extension/components/Wordmark.tsx`) is shared by the extension and the proxy
config page. Android reuses the palette and the launcher mark.

The README banner is generated by `bun run banner:generate` from the popup
tokens, bundled Geist Mono and Departure Mono faces, the measured 440px
popover, the application icon and the runtime bar geometry. Regenerate the SVG
rather than editing it.

## Extension - WXT + SolidJS

Firefox is the primary target; its manifest declares a `magnet:` protocol
handler, so a magnet click opens the review popover and leaves the current page
in place. Chrome has no extension protocol handlers, so it uses a right-click
menu item that appears only on magnet links, plus the popover's **Add** button.

The background worker is the only context that talks to a torrent client.
Popup, add and options pages send typed messages to it (`lib/messages.ts`,
`lib/torrent-service.ts`). Adapters under `lib/clients/` map the client onto
neutral types, while the UI reads only the static catalog, so client SDKs stay
out of page bundles. qBittorrent is the bundled adapter; another client needs a
`ClientKind`, a catalog entry and an adapter registered in
`lib/clients/index.ts`.

The toolbar popover is the main UI. Each row is a name, a 3-block tile bar, live
stats, and inline **Download** and remove actions. The percentage is a tile-font
counter at the bar's right end, and the bar's fill color carries status: steel
blue downloading, sage ready, ochre stalled or zipping, gray paused or errored.
Removal asks whether to keep or delete the files and answers in the row itself.
While open, the popover polls once a second during downloads and once every five
seconds when everything is complete; the background worker polls once a minute
when it is closed and raises a browser notification on completion.

See [`extension/README.md`](extension/README.md) for the full development
loop, including the Firefox protocol handler, Chrome menu behavior,
`moz-extension://` URLs and headless runs.

### Component gallery

`/gallery.html` is a development page with fixed fixtures for token swatches,
controls, every torrent-row state, the popover's loaded/empty/loading/error
lists and the add-flow review screens. It is the visual reference when changing
the design and needs no configured torrent client.

```bash
bun run dev:firefox
bun run urls:firefox   # prints the gallery URL with the other dev pages
```

The gallery is excluded from packaged builds; set `REMAGNET_GALLERY=1` before a
build to include it for review against an installed extension. Component tests
(`bun run test:ui`, Vitest + happy-dom) render the same fixtures from
`extension/gallery/fixtures.ts`.

## Proxy - Rust / Axum

`proxy/` reads files from qBittorrent's Web API and streams a completed torrent
to the browser as a ZIP, so it needs neither the downloads volume nor temporary
disk space.

| Endpoint             | Auth   | Purpose                                    |
| -------------------- | ------ | ------------------------------------------ |
| `GET /`              | none   | Config page for the qBittorrent connection |
| `GET /healthz`       | none   | Liveness probe                             |
| `GET /api/health`    | bearer | Test the saved qBittorrent connection      |
| `GET /api/config`    | bearer | Read non-secret settings                   |
| `PUT /api/config`    | bearer | Update the qBittorrent URL and credentials |
| `GET /archive/:hash` | bearer | Stream a completed torrent as a ZIP        |

`Authorization: Bearer <BRIDGE_TOKEN>` is preferred; `?token=` is a fallback for
browsers whose download API cannot attach headers. Only complete torrents are
served. Entries are stored uncompressed (media files do not benefit from ZIP
deflation), and a failed upstream stream aborts the response so the browser
cannot save a truncated archive.

```bash
cd proxy
cp .env.example .env        # set BRIDGE_TOKEN (openssl rand -hex 32) and QBIT_*
cargo run                   # http://127.0.0.1:8080/
```

`BRIDGE_TOKEN` must be at least 16 characters. `QBIT_BASE_URL`, `QBIT_API_KEY`
or `QBIT_USERNAME`/`QBIT_PASSWORD`, `DATA_DIR` and `BIND_ADDR` configure the
service. The first boot writes `config.json` (mode `0600`) from the environment;
subsequent changes come from the config page and survive restarts. Deploy behind
an HTTPS reverse proxy, then enter that URL and the same token under **Settings
→ Remagnet Proxy** in the extension. A compose file is included for the
shared `media` network.

The crate, binary, Docker image and container keep the historical
`remagnet-bridge` name, as does the token variable, so existing deployments and
reverse-proxy upstreams continue to work. See [`proxy/README.md`](proxy/README.md)
for deployment, configuration and tests.

## Android Client - Kotlin

`android/` builds the Kotlin + Jetpack Compose client. The first three phases
provide the connection settings screen, QR code import, credential storage
encrypted by the Android Keystore, and a direct qBittorrent Web API client for
listing, adding and removing torrents with API-key or cookie authentication.
Magnets arrive through `VIEW magnet:` links or shared text and open a review
sheet over the home screen, with duplicate detection, category/tag defaults and
pause-on-add. The magnet parser mirrors the extension's semantics, and
`ProxyApi` configures the generated Retrofit client with a proxy URL and bearer
token. `:proxy-client` holds the generated proxy sources; the archive endpoint
is a streaming response, so downloads stream to disk instead of buffering the ZIP
in memory.

```bash
bun run android:build                 # ./gradlew :app:assembleDebug
bun run android:test                  # ./gradlew :app:testDebugUnitTest
cd android && ./gradlew :app:lintDebug
cd android && ./gradlew :app:installDebug
```

The torrent list, archive downloads and release signing are planned in
[`android/PLAN.md`](android/PLAN.md). The toolchain, emulator setup, QR payload
format and install steps are documented in
[`android/README.md`](android/README.md). Cleartext HTTP is allowed only for the
emulator host (`10.0.2.2`) and loopback; a deployed proxy must use HTTPS.

## Sponsor this project

Remagnet is built and maintained in the open. If it saves you time, you can
[support this project on Ko-fi](https://ko-fi.com/elijahcunninghamdev).

## Privacy and license

Remagnet runs entirely on your devices and your own server. It has no accounts,
analytics, or telemetry, and it sends nothing to the project. See
[`PRIVACY.md`](PRIVACY.md) for what each component stores locally.

The source is licensed under the [Apache License 2.0](LICENSE).

## Commands

| Command                   | Description                            |
| ------------------------- | -------------------------------------- |
| `bun run dev`             | Start WXT in dev mode (Chrome)         |
| `bun run dev:firefox`     | Start WXT in dev mode (Firefox)        |
| `bun run urls:firefox`    | Print dev extension popup/options URLs |
| `bun run build`           | Build the extension (Chrome)           |
| `bun run build:firefox`   | Build the extension (Firefox)          |
| `bun run zip`             | Package the extension for distribution |
| `bun run test`            | Run unit and component tests           |
| `bun run test:unit`       | Run Bun unit tests                     |
| `bun run test:ui`         | Run Vitest component tests             |
| `bun run api:generate`    | Regenerate the proxy API clients       |
| `bun run banner:generate` | Regenerate the README banner           |
| `bun run typecheck`       | Type-check all workspaces              |
| `bun run check`           | Lint + format check with Biome         |
| `bun run check:write`     | Apply Biome fixes and formatting       |
| `bun run android:build`   | Build the debug Android APK            |
| `bun run android:test`    | Run Android JVM unit tests             |

## qBittorrent notes

- The client targets the qBittorrent Web API v2 (`/api/v2`), supported by
  qBittorrent 4.1+.
- API key auth requires qBittorrent 5.2+ (Web API 2.14.1+). API keys cannot call
  `auth/login` or `auth/logout`, so the client skips them.
- In the extension, password authentication uses the browser cookie store, so
  the extension needs host access to the qBittorrent origin. Grant it on the
  options page.
- Some qBittorrent versions apply CSRF/Referer checks to the Web UI API. If
  requests are rejected, enable "Bypass authentication for clients on localhost"
  or add the extension origin to the Web UI's trusted sources.
- API key, password and Remagnet Proxy token are encrypted with an AES-GCM key that
  JavaScript cannot export before they are written to `browser.storage.local`.
  Extension pages and the background worker decrypt them on demand; web page
  content cannot read the key or the plaintext. Prefer an API key or a
  dedicated qBittorrent user with limited permissions.

## Package usage

```ts
import { QBittorrentClient } from "@remagnet/qbittorrent";

// Preferred: qBittorrent 5.2+ API key (stateless).
const qbt = new QBittorrentClient({
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "qbt_...",
});

// Legacy: username/password cookie auth.
const legacy = new QBittorrentClient({
  baseUrl: "http://127.0.0.1:8080",
  username: "admin",
  password: "adminadmin",
});

await qbt.login(); // no-op for API keys
const torrents = await qbt.getTorrents({ filter: "downloading" });
await qbt.addTorrent({ urls: "magnet:?xt=urn:btih:..." });
```

See [`packages/qbittorrent/README.md`](packages/qbittorrent/README.md) for the
full API surface.
