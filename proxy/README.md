# Remagnet proxy

The Remagnet proxy is a small Rust/axum service that turns completed qBittorrent
torrents into ZIP streams for the browser extension and, later, the Android
client. It talks to qBittorrent over the Docker network and streams each file
from the Web API, so it does not need the downloads volume mounted and does not
store archives.

The directory was formerly `services/archive-bridge`. The crate, binary, Docker
image, container and `BRIDGE_TOKEN` environment variable keep the historical
`remagnet-bridge` name so existing deployments and Caddy upstreams continue to
work unchanged.

## Endpoints

| Endpoint             | Auth   | Purpose                                         |
| -------------------- | ------ | ----------------------------------------------- |
| `GET /`              | none   | Minimal config page (the page itself is static) |
| `GET /healthz`       | none   | Liveness probe                                  |
| `GET /api/health`    | bearer | Test the saved qBittorrent connection           |
| `GET /api/config`    | bearer | Read non-secret settings                        |
| `PUT /api/config`    | bearer | Update the qBittorrent URL and credentials      |
| `GET /archive/:hash` | bearer | Stream a completed torrent as a ZIP             |

`Authorization: Bearer <BRIDGE_TOKEN>` is preferred. `?token=` is accepted as a
fallback for browsers whose download API cannot attach headers.

The config page never receives saved secrets back. Leave an API key or password
field blank to keep the saved value; use the matching checkbox to clear it.

## Configuration

Environment variables:

| Variable                          | Default               | Notes                                                         |
| --------------------------------- | --------------------- | ------------------------------------------------------------- |
| `BRIDGE_TOKEN`                    | required              | At least 16 characters. Generate with `openssl rand -hex 32`. |
| `QBIT_BASE_URL`                   | `http://gluetun:8080` | Bootstrap value for the first boot.                           |
| `QBIT_API_KEY`                    | empty                 | qBittorrent 5.2+ API key.                                     |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | empty                 | Fallback cookie login.                                        |
| `DATA_DIR`                        | `/data`               | `config.json` lives here.                                     |
| `BIND_ADDR`                       | `0.0.0.0:8080`        | HTTP listen address.                                          |

The first boot writes `config.json` (mode `0600`) from the environment. Later
changes come from the config page and survive restarts. The proxy token (still
`BRIDGE_TOKEN`) stays
in the environment and is never written to `config.json`.

## Local development

```bash
cp .env.example .env
# edit .env
set -a && . ./.env && set +a
cargo run
```

Open <http://127.0.0.1:8080/>, paste `BRIDGE_TOKEN`, and test the connection.

## Docker

The compose file expects the external `media` network shared with Caddy and
qBittorrent/gluetun:

```bash
docker compose build
docker compose up -d
```

Put the service behind a local-only reverse-proxy route, for example:

```caddyfile
@remagnet host remagnet.example.com
handle @remagnet {
    import local_only
    reverse_proxy remagnet-bridge:8080
}
```

In the extension options, set the archive URL to `https://remagnet.example.com`
and paste the same proxy token.

## How archiving works

1. Look up the torrent by info hash and require `progress == 1`.
2. List its files with `torrents/files`.
3. For each file, call `torrents/downloadFile` and copy the response into a
   stored (uncompressed) ZIP entry with a data descriptor.
4. Stream the ZIP body back to the browser without buffering the archive.
5. If an upstream file stream fails mid-way, the HTTP body is aborted rather
   than ending cleanly. Without that, browsers save a truncated ZIP as a
   completed download because the response has no `Content-Length`.

Media files do not benefit from ZIP compression, so entries use `Stored`.
qBittorrent requests have no total deadline (archives can take a long time),
but a 60-second read timeout still catches stalled connections.

## Tests

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```
