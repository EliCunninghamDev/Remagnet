<p align="center">
  <img src="docs/remagnet-banner.svg" alt="Remagnet: self-hosted torrent forwarding and download proxy" width="100%">
</p>

# Remagnet

[![CI](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml/badge.svg)](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/site-remagnet.app-blue.svg)](https://remagnet.app)

A self-hosted torrent remote and download proxy for Firefox, Chrome, and Android.
Website: [remagnet.app](https://remagnet.app) ([API reference](https://remagnet.app/api.html) · [Privacy](https://remagnet.app/privacy.html)).

Click a `magnet:` link in Firefox, right-click one in Chrome, open or share a magnet or `.torrent` file on Android, or drop either into the proxy web UI. Remagnet forwards it to your torrent client, tracks progress, and streams finished torrents straight back to your device as uncompressed ZIP files.

Your browsers and phone only talk to **Remagnet Proxy**, a small Rust service that runs next to **qBittorrent**, **Transmission**, **Deluge**, or **rTorrent / ruTorrent**. The proxy holds your client credentials and scopes everything to a Remagnet category or label, so your torrent client never needs to be exposed outside your host or Docker network.

<p align="center">
  <img src="docs/remagnet-demo.gif" alt="Right-clicking a magnet link in Chrome, sending it through Remagnet Proxy, and downloading the finished torrent as a ZIP" width="800">
</p>

<p align="center"><sub>
  Right-click a magnet link, review it, and send it to the proxy.
  Chrome is shown; Firefox handles <code>magnet:</code> clicks directly in the same popover.
</sub></p>

## What it does

- **Browser extension (Firefox & Chrome):** Click `magnet:` links directly in Firefox (via protocol handler) or right-click them in Chrome (magnet-only context menu), paste magnets, or upload `.torrent` files. Review name, info hash, file size, and trackers before sending, check for duplicates, optionally add paused, watch live progress, remove torrents (keeping or deleting files), get desktop completion notifications, and download finished torrents as ZIPs.
- **Android app:** Handles `magnet:` links, `.torrent` files, and shared text system-wide in a bottom sheet over your torrent list. Pair in seconds with the built-in QR camera scanner (or paste a link), and download finished ZIPs in a background foreground service with live cancel, retry, and open notification controls.
- **Proxy web dashboard:** Served directly from Remagnet Proxy with four tabs: **Torrents** (add magnets or `.torrent` files, monitor progress, and download ZIPs from any browser), **Devices** (generate rotating 60-second pairing QR codes/links and revoke devices), **Connection** (configure or switch torrent clients live), and **Account** (Argon2id password and optional TOTP 2FA with recovery codes).

### Supported torrent clients

| Client                                   | Scoping                               | ZIP archive streaming                                         |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| **qBittorrent** (4.1+, 5.2+ for API key) | Category + tags                       | Streams directly from Web API (5.2+), or from `DOWNLOADS_DIR` |
| **Transmission**                         | Labels (`REMAGNET_TAGS`)              | Streams from read-only `DOWNLOADS_DIR` mount                  |
| **Deluge**                               | Single label (`REMAGNET_CATEGORY`)    | Streams from read-only `DOWNLOADS_DIR` mount                  |
| **rTorrent / ruTorrent**                 | `custom1` label (`REMAGNET_CATEGORY`) | Streams from read-only `DOWNLOADS_DIR` mount                  |

## Install

Pre-built packages are published on [GitHub Releases](https://github.com/EliCunninghamDev/Remagnet/releases) while store submissions are underway:

- **Remagnet Proxy:** `ghcr.io/elicunninghamdev/remagnet-proxy:latest` (Docker, `linux/amd64` and `linux/arm64`)
- **Firefox:** Download `remagnet-<version>-firefox.zip` (addons.mozilla.org listing in progress)
- **Chrome:** Download `remagnet-<version>-chrome.zip`, unzip it, enable **Developer mode** in `chrome://extensions`, and choose **Load unpacked** (Chrome Web Store listing in progress)
- **Android:** Download and install `remagnet-<version>.apk` from the latest release (Google Play listing in progress)

## Quick start

### 1. Prepare your torrent client

Make sure your torrent client's API is reachable from the Docker host or shared container network. Only Remagnet Proxy connects to it.

For **qBittorrent** (used in the example below), enable the Web UI and generate an API key under **Preferences → Web UI → API Key** (5.2+, or use username/password on 4.1+). For Transmission, Deluge, or rTorrent / ruTorrent, see [`proxy/.env.example`](proxy/.env.example) and [`proxy/README.md`](proxy/README.md#configuration).

### 2. Deploy Remagnet Proxy

Create a directory on your Docker host with `compose.yaml`:

```yaml
services:
  remagnet-proxy:
    image: ghcr.io/elicunninghamdev/remagnet-proxy:latest
    container_name: remagnet-proxy
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
      # Uncomment for Transmission, Deluge, rTorrent, or qBittorrent < 5.2 ZIP downloads:
      # - /path/to/torrent/downloads:/downloads:ro

volumes:
  remagnet-data:
```

Create `.env` beside it. Every field is optional; anything left unset can be configured and changed later in the web UI (values set in `.env` take precedence and stay locked in the UI):

```dotenv
# Optional: require this code on first boot before creating the admin account.
# Useful if the fresh proxy is reachable on a public network; remove afterward.
SETUP_CODE=

# Torrent client adapter: qbittorrent (default), transmission, deluge, or rtorrent.
CLIENT_KIND=qbittorrent

# Where the proxy reaches your torrent client. On a shared Docker network, use
# the container or service name (for example http://gluetun:8080 or http://transmission:9091).
CLIENT_BASE_URL=http://host.docker.internal:8080
QBIT_API_KEY=

# Needed for ZIP streaming on Transmission, Deluge, and rTorrent (optional fallback on qBittorrent).
# DOWNLOADS_DIR=/downloads
# CLIENT_DOWNLOADS_DIR=/data/torrents

# Category/tags applied to Remagnet torrents and used to scope listing, downloads, and removal.
REMAGNET_CATEGORY=remagnet
REMAGNET_TAGS=remagnet
```

Start the container:

```bash
docker compose pull
docker compose up -d
```

Put the proxy behind HTTPS before connecting from outside your local machine. With Caddy:

```caddyfile
remagnet.example.com {
  reverse_proxy remagnet-proxy:8080
}
```

### 3. Create the admin account

Open your proxy URL (for example `https://remagnet.example.com` or `http://<docker-host>:8080`). On first visit, create an administrator username and password (12+ characters, plus `SETUP_CODE` if set).

In the **Connection** tab, enter or verify your torrent client URL, credentials, optional downloads path, and category/tags, then click **Test connection**. Under **Account**, you can enable TOTP two-factor authentication and save your eight single-use recovery codes.

### 4. Connect Firefox, Chrome, or Android

Both ways to connect mint a dedicated, revocable per-device token (`rmg_...`):

- **Sign in directly:** Open **Settings** in the extension or Android app and enter your proxy URL, admin username, password, and (if enabled) 2FA code. Only the minted device token is saved; your password and 2FA code are dropped immediately.
- **Pair with QR or link (no 2FA needed):** Open the **Devices** tab in the proxy web UI. Scan the rotating QR code with the Android app, or copy the `remagnet://pair` link into the extension. Pairing codes expire after 60 seconds, work once, and encrypt the returned token end-to-end with AES-256-GCM.

You can disconnect from the device itself or revoke any connected browser or phone immediately from the **Devices** tab.

## Security & privacy

- **Zero telemetry:** Everything runs on your own devices and server. No hosted accounts, analytics, update checks, or third-party requests. See [`PRIVACY.md`](PRIVACY.md) or [remagnet.app/privacy.html](https://remagnet.app/privacy.html).
- **Scoped device tokens:** Clients hold only the proxy URL and a revocable `rmg_...` token (encrypted via WebCrypto AES-GCM in browsers and Android Keystore on Android). Device tokens can only list, add, download, and remove torrents matching the proxy's filter, and receive `403` on admin routes.
- **Streamed ZIPs, no temp files:** Completed torrents stream directly into an uncompressed ZIP response without writing archives to disk. Chrome uses single-use 60-second download tickets so device tokens never appear in URLs or browser history.
- **Opt-in diagnostics:** The **Report issue** dialog generates a redacted diagnostics snippet for you to inspect first and never transmits anything automatically.
- **Vulnerability reports:** See [`SECURITY.md`](SECURITY.md).

## Development & documentation

Remagnet is a monorepo with a Rust/Axum proxy, a WXT + SolidJS browser extension, a Kotlin + Jetpack Compose Android app, shared UI/client packages, and a containerized integration suite covering all four torrent clients.

**Prerequisites:** Bun `1.4.5+`, stable Rust (`rustfmt`, `clippy`), Docker (for the local dev stack and integration suite), and JDK 21 + Android SDK if working on OpenAPI codegen or Android.

```bash
bun install

# Start a local Transmission dev container with seeded offline fixtures, plus the Rust proxy
bun run dev:client -- --seed
bun run dev:proxy

# Run the browser extension in dev mode (Firefox MV2 or Chrome MV3)
bun run dev:firefox
bun run dev

# Run unit tests, UI component tests, and Biome checks
bun run test
bun run check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full command table, OpenAPI code generation, design tokens, and release workflow. Subsystem documentation lives alongside each component:

| Document                                                     | Contents                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                         | Repository layout, full dev commands, OpenAPI codegen, design tokens, release workflow      |
| [`proxy/README.md`](proxy/README.md)                         | Rust/Axum proxy auth model, HTTP endpoints, env vars, Docker/Caddy setup, ZIP streaming     |
| [`proxy/openapi.yaml`](proxy/openapi.yaml)                   | Canonical OpenAPI 3.1 contract shared by TypeScript and Kotlin clients                      |
| [`extension/README.md`](extension/README.md)                 | WXT + SolidJS architecture, Firefox protocol handler, Chrome menu script, component gallery |
| [`android/README.md`](android/README.md)                     | Kotlin + Compose architecture, Keystore storage, QR pairing, emulator & Gradle workflows    |
| [`tests/integration/README.md`](tests/integration/README.md) | Containerized end-to-end tests against real qBittorrent, Transmission, Deluge, and rTorrent |
| [`demo/README.md`](demo/README.md)                           | Automated demo GIF/video recording against a mock proxy                                     |
| [`promo/README.md`](promo/README.md)                         | Reproducible store screenshot and promotional asset renders                                 |
| [`PRIVACY.md`](PRIVACY.md)                                   | Local storage details and browser/Android permission justifications                         |
| [`SECURITY.md`](SECURITY.md)                                 | Security model and private vulnerability reporting                                          |

## Support

Remagnet is built and maintained in the open. If it saves you time, you can [support the project on Ko-fi](https://ko-fi.com/elijahcunninghamdev).

## License

Licensed under the [Apache License 2.0](LICENSE).
