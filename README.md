<p align="center">
  <img src="docs/remagnet-banner.svg" alt="Remagnet: convenient torrent forwarding and download proxy" width="100%">
</p>

# Remagnet

[![CI](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml/badge.svg)](https://github.com/EliCunninghamDev/Remagnet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A self-hosted torrent forwarding and download proxy for Firefox, Chrome, and
Android.

Click a `magnet:` link in Firefox, right-click one in Chrome, or tap/share one
on Android to send it to your qBittorrent instance—then monitor progress and
download completed torrents straight to your device as streamed ZIP files.

Clients talk only to **Remagnet Proxy**, a small Rust/Docker service that sits
next to qBittorrent. The proxy owns your qBittorrent credentials and the
category/tags that mark Remagnet torrents, so qBittorrent never needs to be
exposed outside your host or Docker network.

<p align="center">
  <img src="docs/remagnet-demo.gif" alt="Right-clicking a magnet link on The ISO Bay in Chrome, sending it to qBittorrent through Remagnet, then downloading the finished torrent as a ZIP" width="800">
</p>

<p align="center"><sub>
  Right-click a magnet link, review it, and send it to the client.
  Chrome is shown; in Firefox a <code>magnet:</code> click opens the same popover.
</sub></p>

## Install

Pre-built packages are published on
[GitHub Releases](https://github.com/EliCunninghamDev/Remagnet/releases) while
store listings are in progress:

- **Remagnet Proxy:** `ghcr.io/elicunninghamdev/remagnet-proxy:latest`
  (Docker, `linux/amd64` and `linux/arm64`)
- **Firefox:** Download `remagnet-<version>-firefox.zip` (or install from
  addons.mozilla.org once approved)
- **Chrome:** Download `remagnet-<version>-chrome.zip`, unzip, enable
  **Developer mode** in `chrome://extensions`, and choose **Load unpacked**
  (Chrome Web Store listing coming soon)
- **Android:** Download and install `remagnet-<version>.apk` from the latest
  release

## Quick start

### 1. Prepare qBittorrent

Enable the Web UI and generate an API key under **Preferences → Web UI → API
Key** (qBittorrent 5.2 or newer; username/password login also works for 4.1+).
Note the Web UI URL reachable from the proxy container—only the proxy connects
to qBittorrent.

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

volumes:
  remagnet-data:
```

Create `.env` beside it (every field is optional; you can finish setup in the
web UI):

```dotenv
# Optional: require this code on first boot before creating the admin account.
# Useful when exposing a fresh proxy to the public internet; remove afterward.
SETUP_CODE=

# Where the proxy reaches qBittorrent's Web UI. Use the service name on a
# shared Docker network (for example http://gluetun:8080).
QBIT_BASE_URL=http://host.docker.internal:8080
QBIT_API_KEY=

# Category and tags applied to Remagnet magnets and used to scope listing,
# downloads, and removal.
REMAGNET_CATEGORY=remagnet
REMAGNET_TAGS=remagnet
```

Start the container:

```bash
docker compose pull
docker compose up -d
```

Expose the proxy over HTTPS before connecting from another machine. A minimal
Caddy configuration:

```caddyfile
remagnet.example.com {
  reverse_proxy remagnet-proxy:8080
}
```

### 3. Create the administrator account

Open your proxy URL (e.g. `https://remagnet.example.com` or
`http://<docker-host>:8080`). On first visit, create your administrator username
and password (12+ characters; enter `SETUP_CODE` if configured).

Then enter your qBittorrent Web UI URL, API key (or username/password), and
category/tags, and click **Test connection**. You can also enable optional TOTP
two-factor authentication under **Account & security** and save the eight
single-use recovery codes.

### 4. Connect Firefox, Chrome, or Android

Both enrolment paths mint a dedicated, revocable per-device token (`rmg_…`):

- **Sign in directly:** Open **Settings** in the extension or Android app, enter
  your proxy URL, admin username, password, and (if enabled) 2FA code. Only the
  minted device token is stored—your password and 2FA code are never saved.
- **Pair without 2FA:** In the proxy web UI's **Pair a device** panel, scan the
  rotating QR code from Android or click **Copy link** and paste it into the
  extension. Pairing codes expire after 60 seconds, work once, and skip 2FA.

Manage or revoke connected browsers and phones anytime from the **Connected
devices** panel in the proxy web UI, or click **Disconnect** on the device
itself.

## Security & privacy

- **Local-first & zero telemetry:** Remagnet runs entirely on your devices and
  server, with no hosted accounts, analytics, or external requests. See
  [`PRIVACY.md`](PRIVACY.md).
- **Least-privilege tokens:** Devices receive scoped tokens that can only list,
  add, download, and remove torrents matching the proxy's configured
  category/tags—never admin settings or unrelated torrents in qBittorrent.
- **No stored torrent files:** Completed torrents are streamed straight from
  qBittorrent's Web API into an uncompressed ZIP response (using single-use
  60-second tickets on Chrome so tokens never appear in URLs).
- **Reporting vulnerabilities:** See [`SECURITY.md`](SECURITY.md).

## Contributing & documentation

Want to build from source, run the test suites, modify the OpenAPI contract, or
cut a release? See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full repository
map, dev commands, and links to each component's docs:

- [`proxy/README.md`](proxy/README.md) — Rust/Axum proxy endpoints, config, and
  Docker setup ([`proxy/openapi.yaml`](proxy/openapi.yaml))
- [`extension/README.md`](extension/README.md) — WXT + SolidJS browser
  extension, Firefox/Chrome dev loops, and component gallery
- [`android/README.md`](android/README.md) — Kotlin + Jetpack Compose app,
  emulator workflow, and build steps
- [`demo/README.md`](demo/README.md) — Scripted demo recording

## Sponsor this project

Remagnet is built and maintained in the open. If it saves you time, you can
[support this project on Ko-fi](https://ko-fi.com/elijahcunninghamdev).

## License

Licensed under the [Apache License 2.0](LICENSE).
