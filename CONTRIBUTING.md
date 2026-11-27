# Contributing to Remagnet

This guide covers the repository structure, documentation map, development
workflows, code generation, and release process.

## Repository layout

```text
proxy/                Rust/Axum proxy service, OpenAPI 3.1 contract, ZIP streaming
extension/            Firefox (MV2) and Chrome (MV3) extension (WXT + SolidJS)
android/              Android client (Kotlin + Jetpack Compose)
packages/
  proxy-client/       TypeScript client generated from proxy/openapi.yaml
  ui/                 Shared SolidJS components, styles and helpers
  proxy-ui/           SolidJS administrator dashboard bundled into proxy/src/ui.html
site/                 Lightweight static landing, privacy, and API reference pages
tests/integration/    Containerized end-to-end test suite (all 4 torrent clients)
demo/                 Scripted demo recording and mock proxy server
promo/                Reproducible store screenshot and promo renders
docs/                 Generated README banner, demo media, and store submission notes
scripts/              API client, banner, dev stack, site, and version tooling
tokens.js             Design tokens (DTCG 2025.10)
```

## Documentation map

Each subsystem owns its detailed reference so documentation stays close to the
code and avoids duplication:

| Document                                                             | Scope                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`README.md`](README.md)                                             | User overview, installation, and Docker Compose quick start                                      |
| [`proxy/README.md`](proxy/README.md)                                 | Proxy auth model, HTTP endpoint reference, environment variables, Docker/Caddy setup             |
| [`proxy/openapi.yaml`](proxy/openapi.yaml)                           | Canonical OpenAPI 3.1 contract for all clients                                                   |
| [`extension/README.md`](extension/README.md)                         | WXT + SolidJS architecture, Firefox protocol handler, Chrome menu script, gallery, headless runs |
| [`android/README.md`](android/README.md)                             | Kotlin/Compose architecture, keystore storage, emulator workflow, Gradle tasks                   |
| [`android/PLAN.md`](android/PLAN.md)                                 | Android buildout phases and release keystore signing setup                                       |
| [`packages/proxy-client/README.md`](packages/proxy-client/README.md) | Generated TypeScript client usage                                                                |
| [`tests/integration/README.md`](tests/integration/README.md)         | Containerized end-to-end suite against qBittorrent, Transmission, Deluge, and rTorrent           |
| [`demo/README.md`](demo/README.md)                                   | Automated demo recording against `demo/mock-proxy.ts`                                            |
| [`promo/README.md`](promo/README.md)                                 | Reproducible store screenshot and promotional asset renders                                      |
| [`docs/store-listing.md`](docs/store-listing.md)                     | Chrome Web Store and Firefox AMO listing copy, permission justifications, and reviewer notes     |
| [`PRIVACY.md`](PRIVACY.md)                                           | Data storage and browser/Android permission justifications                                       |
| [`SECURITY.md`](SECURITY.md)                                         | Security model and vulnerability reporting policy                                                |

## Prerequisites

- **Bun** `1.4.5+` (extension, scripts, Biome, tests)
- **Rust** stable with `rustfmt` and `clippy` (Remagnet Proxy)
- **JDK 21** (required for `bun run api:generate` and Android builds)
- **Android SDK** (only needed when building/testing `android/`; see [`android/README.md`](android/README.md#toolchain))

Install JavaScript workspace dependencies from the repository root:

```bash
bun install
```

## Commands

| Command                        | Description                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `bun run dev`                  | Start WXT in dev mode (Chrome MV3)                                                                |
| `bun run dev:firefox`          | Start WXT in dev mode (Firefox MV2 — primary target)                                              |
| `bun run dev:client`           | Start a dev torrent container (Transmission by default; `--client qbittorrent\|deluge\|rtorrent`) |
| `bun run dev:client:ephemeral` | Run an auto-cleaning dev stack in the foreground and seed fixtures                                |
| `bun run dev:proxy`            | Run the Rust proxy locally against the dev client                                                 |
| `bun run dev:seed`             | Write deterministic `.torrent` fixtures into `.dev/dev-stack/fixtures`                            |
| `bun run dev:down`             | Stop dev containers, keeping volumes and `.dev/dev-stack`                                         |
| `bun run dev:clean`            | Stop dev containers, delete volumes, and remove `.dev/dev-stack`                                  |
| `bun run urls:firefox`         | Print dev extension popup, add, options, and gallery URLs                                         |
| `bun run build`                | Production Chrome build                                                                           |
| `bun run build:firefox`        | Production Firefox build                                                                          |
| `bun run proxy:ui:build`       | Build the SolidJS proxy dashboard into `proxy/src/ui.html`                                        |
| `bun run proxy:ui:dev`         | Run the proxy dashboard with Vite against a local proxy                                           |
| `bun run zip`                  | Package Chrome extension ZIP                                                                      |
| `bun run zip:firefox`          | Package Firefox extension ZIP and AMO source ZIP                                                  |
| `bun run lint:firefox`         | Validate the built Firefox add-on with `web-ext lint`                                             |
| `bun run test`                 | Run Bun unit tests and Vitest UI component tests                                                  |
| `bun run test:unit`            | Run Bun unit tests (`tokens`, `extension/lib`, `packages/proxy-client`)                           |
| `bun run test:ui`              | Run Vitest + happy-dom extension and proxy dashboard component tests                              |
| `bun run typecheck`            | Type-check all TypeScript workspaces                                                              |
| `bun run check`                | Lint and format check with Biome                                                                  |
| `bun run check:write`          | Apply Biome fixes and formatting                                                                  |
| `bun run api:generate`         | Regenerate TypeScript and Kotlin clients from `proxy/openapi.yaml`                                |
| `bun run banner:generate`      | Regenerate `docs/remagnet-banner.svg` from `tokens.js`                                            |
| `bun run promo`                | Build promo screen bundle and launch interactive Promo Studio                                     |
| `bun run promo:render`         | Bulk-render all store screenshots and promo tiles into `promo/out/`                               |
| `bun run site:build`           | Build static landing site into `site/dist/`                                                       |
| `bun run version:check`        | Verify all component versions match                                                               |
| `bun run version:set`          | Bump version across all manifests and lockfiles                                                   |
| `bun run android:build`        | Build the debug Android APK                                                                       |
| `bun run android:test`         | Run Android JVM unit tests                                                                        |

### Proxy commands

```bash
cd proxy
cp .env.example .env
set -a && . ./.env && set +a
cargo run
```

Before opening a pull request that touches `proxy/`:

```bash
cargo fmt --manifest-path proxy/Cargo.toml --check
cargo clippy --manifest-path proxy/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path proxy/Cargo.toml
```

### Local torrent client (Docker)

`compose.dev.yml` runs Transmission by default on loopback only. Docker and
Docker Compose are required. Start the client and seed the offline fixtures:

```bash
bun run dev:client -- --seed
bun run dev:proxy
```

The Transmission Web UI is at <http://127.0.0.1:19091> (no authentication on
localhost). `--seed` writes deterministic `.torrent` files to
`.dev/dev-stack/fixtures/` and pre-places the completed payload in the client's
download directory, so adding `remagnet-dev-complete.torrent` reaches 100% and
exercises ZIP streaming without network peers. `remagnet-dev-sample.torrent`
has no payload and is useful for testing paused, uploading, and removal states.

The client config volume, the proxy `DATA_DIR` (`proxy-data`), and the
host-owned downloads directory persist across `bun run dev:down`. Use
`bun run dev:clean` to delete the volumes and `.dev/dev-stack` as well.

For a foreground stack that removes containers, volumes, and `.dev/dev-stack`
when you press Ctrl+C:

```bash
bun run dev:client:ephemeral
```

Switch to qBittorrent (Web UI at <http://127.0.0.1:18080>, `admin` /
`adminadmin`):

```bash
bun run dev:client -- --client qbittorrent --seed
bun run dev:proxy -- --client qbittorrent
```

To run the proxy in a container, enable the `proxy` Compose profile. Set
`DEV_CLIENT_KIND` and `DEV_CLIENT_BASE_URL` when the client is not the default
Transmission service:

```bash
docker compose -f compose.dev.yml --profile proxy up -d --build
```

### Android commands

```bash
bun run android:test
bun run android:build
./android/gradlew -p android :app:lintDebug
```

## OpenAPI contract & generated clients

[`proxy/openapi.yaml`](proxy/openapi.yaml) is the single source of truth for
every HTTP endpoint and schema. Neither the TypeScript client
(`packages/proxy-client/src/schema.d.ts`) nor the Kotlin Retrofit client
(`android/proxy-client/src/main/java/dev/remagnet/proxy/`) is edited by hand.

Whenever you change a route, request body, response shape, or error code in
`proxy/`:

1. Update `proxy/openapi.yaml`.
2. Regenerate both clients (requires JDK 21):

   ```bash
   bun run api:generate
   ```
3. Commit the regenerated sources alongside the spec change so CI and downstream
   builds never need to run the generator.

## Design tokens & component gallery

[`tokens.js`](tokens.js) defines the shared visual system in the
[DTCG 2025.10 format](https://www.designtokens.org/tr/2025.10/format/) (light,
dark, and popup color schemes, typography, spacing, dimensions, and motion).

- `extension/assets/app.css`, `proxy/src/ui.html`, `site/styles.css`, and the
  Android theme mirror these tokens.
- `tokens.test.ts` validates the token schema and types during `bun run test`.
- `bun run banner:generate` regenerates `docs/remagnet-banner.svg` directly from
  `tokens.js` and the bundled fonts—regenerate it rather than editing the SVG by
  hand.
- `/gallery.html` renders all extension UI states against fixed fixtures in
  `extension/gallery/fixtures.ts` without needing a running proxy:

  ```bash
  bun run dev:firefox
  bun run urls:firefox
  ```

  The gallery is omitted from production builds unless `REMAGNET_GALLERY=1` is
  set.

## Architecture notes

- **Proxy as sole backend:** `proxy/` is the only component that talks to the
  torrent client (qBittorrent Web API v2, Transmission RPC, Deluge Web API, or
  rTorrent / ruTorrent XML-RPC). It owns client credentials (`config.json`, mode
  `0600`), authentication/2FA/device-token hashes (`auth.json`, mode `0600`),
  and the category/tag scope (`REMAGNET_CATEGORY` / `REMAGNET_TAGS`).
- **Least-privilege clients:** The extension and Android app store only the
  proxy URL and an encrypted per-device token (`rmg_…`). Device tokens can call
  `/api/health`, `/api/torrents*`, `/api/archive/{hash}/ticket`, `/archive/{hash}`,
  and `DELETE /api/devices/current`, and are rejected with `403` on admin routes.
- **Extension background boundary:** In `extension/`, only the background worker
  talks to the proxy; popup, add, and options pages communicate with it via
  typed messages (`extension/lib/messages.ts`).
- **Client compatibility:** qBittorrent targets Web API v2 (4.1+; API key auth
  and direct Web API ZIP streaming require 5.2+), sending both `paused` and
  `stopped` when adding paused torrents for 4.x and 5.x compatibility.
  Transmission, Deluge, and rTorrent stream completed ZIPs from a read-only
  `DOWNLOADS_DIR` mount.

## Releases

Every component shares one semantic version. Bump, check, commit, and tag:

```bash
bun run version:set 0.6.0
bun run version:check v0.6.0
git add -A
git commit -m "Release 0.6.0"
git tag v0.6.0
git push origin main --tags
```

Pushing a `vMAJOR.MINOR.PATCH` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies
all versions and runs extension, proxy, Android, and containerized integration
checks (against real qBittorrent, Transmission, Deluge, and rTorrent
containers). The image is only pushed and the GitHub release only created once
every check passes. It publishes:

- `remagnet-<version>-chrome.zip`, `remagnet-<version>-firefox.zip`, and
  `remagnet-<version>-firefox-sources.zip` (for addons.mozilla.org review)
- `remagnet-<version>.apk` and `remagnet-<version>.aab` (when the four
  `ANDROID_KEYSTORE_*` secrets are configured; otherwise a debug APK)
- `SHA256SUMS` for every release asset
- Multi-arch (`linux/amd64`, `linux/arm64`) Docker image at
  `ghcr.io/elicunninghamdev/remagnet-proxy` tagged `<version>`,
  `<major>.<minor>`, `<major>`, and `latest`

Store uploads to addons.mozilla.org and the Chrome Web Store are manual. To
retry a release without moving its tag, dispatch the **Release** workflow
manually with the tag name.
