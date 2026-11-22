<p align="center">
  <img src="docs/remagnet-banner.svg" alt="Remagnet — magnet links, straight to your torrent client" width="100%">
</p>

# Remagnet

A Bun-powered monorepo for re-adding magnet links to torrent clients. The
browser extension is the primary client, a Rust proxy handles server-side
archive streaming, and an Android app is in progress. qBittorrent is the first
backend; the extension uses a client-adapter layer so other clients can be added
without touching the UI or message code.

<p align="center">
  <img src="docs/remagnet-demo.gif" alt="Right-clicking a magnet link in Chrome and sending it to qBittorrent through Remagnet" width="800">
</p>

<p align="center"><sub>
  Right-click a magnet link, review it, and send it to the client.
  Chrome is shown; in Firefox a <code>magnet:</code> click opens the same popover.
</sub></p>

## Layout

The repository is split by deliverable. The extension talks to qBittorrent
directly and can use the proxy for archive streaming; the Android client will
follow the same boundary. The proxy is the only server-side component.

```
extension/            WXT browser extension (SolidJS)
proxy/                Rust/axum proxy for qBittorrent (ZIP streaming, optional)
android/              Android client (Kotlin + Compose, early scaffold)
packages/
  qbittorrent/        Typed qBittorrent Web API v2 client (TypeScript)
  proxy-client/       Generated TypeScript client for the proxy
demo/                 Reproducible README demo recording
docs/                 Screenshots, video and other media
scripts/              Repository tasks, including API client generation
tokens.js             Design Tokens Community Group (DTCG) tokens
```

- **Runtime / package manager:** [Bun](https://bun.sh) workspaces
- **Lint / format:** [Biome](https://biomejs.dev)
- **Extension:** [WXT](https://wxt.dev) + SolidJS + TypeScript
- **qBittorrent:** hand-rolled `fetch` client, no runtime dependencies
- **Proxy:** Rust + axum (optional ZIP downloads for completed torrents)
- **Android:** Kotlin + Jetpack Compose, Gradle version catalog

## Design tokens

[`tokens.js`](tokens.js) describes the visual system in the
[Design Tokens Community Group 2025.10 format](https://www.designtokens.org/tr/2025.10/format/):
the light, dark and popup color schemes, type scale, spacing, layout dimensions
and motion. It is a plain ES module, so scripts and design tooling can import it
without a build step; `JSON.stringify(tokens)` produces a valid `.tokens.json`
document.

The extension's `assets/app.css` currently mirrors these values. Update both
when the visual system changes; `bun run test` checks the token structure and
type values. The Remagnet wordmark is a single shared component
(`extension/components/Wordmark.tsx`) on every extension surface, and the proxy
and Android scaffold reuse the same palette and mark.

## Component gallery

While WXT is running, the extension builds a dev-only gallery at
`/gallery.html`. It renders the real Solid components and `assets/app.css` in
the browser, not a separate mock-up: token swatches, typography, controls, every
torrent-row state, the full popover list (loaded, empty, loading, errors) and
the add-flow review states. It is the visual oracle when changing the design,
and it needs no configured torrent client.

```bash
bun run dev:firefox
bun run urls:firefox   # prints the gallery URL with the other dev pages
```

The gallery is excluded from packaged builds. Set `REMAGNET_GALLERY=1` before a
build to include it for a design review against an installed extension. The
component tests (`bun run test:ui`, Vitest + happy-dom) render the same
components with the fixtures from `extension/gallery/fixtures.ts`, so the
gallery and the assertions stay in sync.

## Getting started

```bash
bun install
bun run dev:firefox   # Firefox is the primary development target
# bun run dev         # Chrome
```

Firefox opens with the extension already installed. Use the options page to
choose a client, point it at the Web UI, grant host access and set default
category/tags, then open the popup to see your torrents. The popup only lists
torrents that match those defaults (category or tags), so a shared qBittorrent
instance does not bury Remagnet's magnets under the rest of the library.

The popup can also remove a torrent from the client, either keeping or deleting
its files, and the background worker polls once a minute to raise a browser
notification when a Remagnet torrent finishes. Adding a magnet also happens in
the popover; a `magnet:` click hands the link to the popover instead of covering
the current page. See `extension/README.md` for the full dev loop, including
how to print the `moz-extension://` URLs for the popup and options pages and how
to run it headless.

Open the extension's options page, enter the qBittorrent Web UI URL, and choose an
authentication method:

- **API key** (recommended, qBittorrent 5.2+): generate one under
  Preferences → Web UI → API Key. Requests use `Authorization: Bearer <key>`,
  with no login round-trip or cookies.
- **Username & password**: uses the classic SID cookie flow and re-authenticates
  automatically when the session expires.

Grant access to the qBittorrent origin when the browser prompts.

## Commands

| Command                 | Description                            |
| ----------------------- | -------------------------------------- |
| `bun run dev`           | Start WXT in dev mode (Chrome)         |
| `bun run dev:firefox`   | Start WXT in dev mode (Firefox)        |
| `bun run urls:firefox`  | Print dev extension popup/options URLs |
| `bun run build`         | Build the extension (Chrome)           |
| `bun run build:firefox` | Build the extension (Firefox)          |
| `bun run zip`           | Package the extension for distribution |
| `bun run test`          | Run unit and component tests           |
| `bun run test:unit`     | Run Bun unit tests                     |
| `bun run test:ui`       | Run Vitest component tests             |
| `bun run api:generate`  | Regenerate the proxy API clients       |
| `bun run typecheck`     | Type-check all workspaces              |
| `bun run check`         | Lint + format check with Biome         |
| `bun run check:write`   | Apply Biome fixes and formatting       |
| `bun run android:build` | Build the debug Android APK            |
| `bun run android:test`  | Run Android JVM unit tests             |

## Android client (early)

`android/` is a Kotlin + Jetpack Compose scaffold for the Android client. It
currently renders a placeholder screen and includes the first shared domain
logic, a magnet parser with unit tests, and a generated Retrofit client for the
proxy in the `:proxy-client` module. The client will reuse the same review and
add semantics as the extension, with the proxy available for authenticated
remote access.

```bash
bun run android:build                 # ./gradlew :app:assembleDebug
bun run android:test                  # ./gradlew :app:testDebugUnitTest
cd android && ./gradlew :app:installDebug
```

The development environment (JDK 21, Android SDK, KVM-accelerated emulator and
the `remagnet-api36` AVD) is documented in `android/README.md`. Cleartext HTTP
is allowed only for the emulator host (`10.0.2.2`) and loopback; a deployed
proxy must be reached over HTTPS.

## Archive proxy (optional)

Completed torrents can be streamed to the browser as a ZIP. The extension asks
the background worker to start the download, and the background worker requests
`/archive/<info-hash>` from the Rust/axum proxy. The proxy reads files from
qBittorrent's Web API, so it needs neither the downloads volume nor temporary
disk space.

```bash
cd proxy
cp .env.example .env        # set BRIDGE_TOKEN (openssl rand -hex 32) and QBIT_*
cargo run                   # http://127.0.0.1:8080/
```

Generate a token with `openssl rand -hex 32`, put the proxy behind an HTTPS
reverse proxy (for example `https://remagnet.example.com`), then enter that URL
and the same token under **Settings → Archive downloads**. Keep the token out of
the repository; it belongs in the server-side `.env` and in extension storage.

The proxy only streams torrents that are complete, accepts
`Authorization: Bearer <token>` (used by Firefox downloads) and `?token=` as a
fallback, and exposes a small config page at `/` for the qBittorrent URL and
credentials. Its HTTP contract is described by `proxy/openapi.yaml`. See
`proxy/README.md` for deployment details. The crate, binary,
Docker image and `BRIDGE_TOKEN` variable keep their historical names so an
existing deployment continues to run unchanged.

The extension and Android app consume generated clients instead of hand-written
requests: `packages/proxy-client` has TypeScript types and an `openapi-fetch`
wrapper, and `android/proxy-client` contains the Retrofit/Kotlin sources. Both
come from the same spec:

```bash
bun run api:generate   # needs JDK 21 for OpenAPI Generator
```

Commit the regenerated sources with any spec change so extension and Android
builds stay reproducible without running the generator.

## qBittorrent notes

- The client targets the qBittorrent **Web API v2** (`/api/v2`), supported by qBittorrent 4.1+.
- API key auth requires qBittorrent **5.2+** (Web API 2.14.1+). API keys cannot call the
  `auth/login` or `auth/logout` endpoints, so the client skips them entirely.
- In the extension (browser cookie mode) password authentication relies on the browser
  cookie store, so the extension needs host access to the qBittorrent origin. Grant it on
  the options page.
- Some qBittorrent versions apply CSRF/Referer checks to the Web UI API. If requests are
  rejected, enable "Bypass authentication for clients on localhost" or add the extension
  origin to the Web UI's trusted sources, depending on your qBittorrent version.
- Credentials are stored in `browser.storage.local` (plain text) and only used by the
  background worker. Prefer an API key or a dedicated qBittorrent user with limited
  permissions.

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

See `packages/qbittorrent/README.md` for the full API surface.
