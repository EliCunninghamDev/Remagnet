# Remagnet Proxy

The Remagnet proxy is the required adapter between the browser extension or
Android client and qBittorrent. It adds, lists, filters and removes torrents
through qBittorrent's Web API and turns completed torrents into ZIP streams. It
talks to qBittorrent over the Docker network and streams each file from the Web
API, so it does not need the downloads volume mounted and does not store
archives. Clients only ever hold the proxy URL and token; qBittorrent
credentials stay on this service.

The directory was formerly `services/archive-bridge`. The crate, binary, Docker
image, container and `BRIDGE_TOKEN` environment variable keep the historical
`remagnet-bridge` name so existing deployments and Caddy upstreams continue to
work unchanged.

## Endpoints

| Endpoint                           | Auth   | Purpose                                                     |
| ---------------------------------- | ------ | ----------------------------------------------------------- |
| `GET /`                            | none   | Minimal config page (the page itself is static)             |
| `GET /assets/departure-mono.woff2` | none   | Wordmark font used by the config page                       |
| `GET /healthz`                     | none   | Liveness probe                                              |
| `GET /api/health`                  | bearer | Proxy capabilities, defaults and qBittorrent versions       |
| `GET /api/config`                  | bearer | Read non-secret settings                                    |
| `PUT /api/config`                  | bearer | Update the qBittorrent URL, credentials and magnet defaults |
| `GET /api/torrents`                | bearer | List torrents owned by Remagnet                             |
| `POST /api/torrents`               | bearer | Add magnets with the configured category/tags               |
| `GET /api/torrents/:hash`          | bearer | Read one torrent, unfiltered                                |
| `DELETE /api/torrents/:hash`       | bearer | Remove a torrent owned by Remagnet                          |
| `POST /api/pair`                   | bearer | Mint a short-lived mobile pairing code                      |
| `DELETE /api/pair/:id`             | bearer | Revoke a pairing code                                       |
| `POST /api/pair/claim`             | none   | Claim a code; returns encrypted settings                    |
| `GET /archive/:hash`               | bearer | Stream a completed torrent as a ZIP                         |

`Authorization: Bearer <BRIDGE_TOKEN>` is preferred. `?token=` is accepted as a
fallback for browsers whose download API cannot attach headers.

The proxy is the only component that talks to qBittorrent. It owns the Web UI
credentials and the category/tags applied to Remagnet magnets, exposes neutral
torrent endpoints, and keeps qBittorrent credentials off the extension and
Android client. `GET /api/torrents` filters by the configured category/tags;
`POST /api/torrents` always applies them and ignores any client-supplied values;
`DELETE /api/torrents/:hash` refuses torrents outside that filter.

Pairing (v2) is how the proxy hands a device the proxy URL and token without
embedding them in a QR image. `POST /api/pair` requires the bridge token and
returns an id, a 32-byte code, the `remagnet://pair` link, and an inline SVG QR
code. The code lives in memory for 60 seconds and is single-use. The Android app
sends the session id and `SHA-256(code)`; the extension can paste the same link
into its **Remagnet Proxy → Pairing code** field. The proxy returns
`{ version: 2, proxyToken }` encrypted with AES-256-GCM under a key derived from
the code and id, so a logged request or response cannot be decrypted without the
code. qBittorrent credentials and magnet defaults are never part of the pairing
payload: the device uses the proxy token against `/api/torrents` for everything
else.

The config page's **Pair a device** panel mints and rotates the code, renders the
QR, and revokes it when hidden. Minting also accepts the origin to encode:

```json
{ "url": "https://remagnet.example.com" }
```

If `url` is omitted, the proxy reconstructs the origin from `Host` and
`X-Forwarded-Proto`. Pairing requires HTTPS unless the origin is loopback or the
Android emulator host `10.0.2.2`.

The machine-readable contract is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).
It documents both authentication styles, the request and response bodies, and
every error status, so it can be imported into Bruno, Insomnia, Postman or
rendered with Swagger UI.

The clients are generated from this file rather than maintained by hand:
`packages/proxy-client/src/schema.d.ts` and the Retrofit sources under
`android/proxy-client/src/main/java/dev/remagnet/proxy/`. After changing the
contract, regenerate both and commit the result:

```bash
bun run api:generate
```

The config page never receives saved secrets back. Leave an API key or password
field blank to keep the saved value; use the matching checkbox to clear it.

The page uses the same Remagnet wordmark as the extension. Departure Mono is
bundled at `src/departure-mono.woff2` under the SIL OFL 1.1
(`src/OFL-DepartureMono.txt`); keep that copy in sync with
`extension/public/fonts/departure-mono-regular.woff2`.

## Configuration

Environment variables:

| Variable                          | Default               | Notes                                                           |
| --------------------------------- | --------------------- | --------------------------------------------------------------- |
| `BRIDGE_TOKEN`                    | required              | At least 16 characters. Generate with `openssl rand -hex 32`.   |
| `QBIT_BASE_URL`                   | `http://gluetun:8080` | Bootstrap value for the first boot.                             |
| `QBIT_API_KEY`                    | empty                 | qBittorrent 5.2+ API key.                                       |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | empty                 | Fallback cookie login.                                          |
| `REMAGNET_CATEGORY`               | `remagnet`            | Category applied to added magnets and used for listing.         |
| `REMAGNET_TAGS`                   | `remagnet`            | Comma-separated tags applied to magnets and used for filtering. |
| `DATA_DIR`                        | `/data`               | `config.json` lives here.                                       |
| `BIND_ADDR`                       | `0.0.0.0:8080`        | HTTP listen address.                                            |

The first boot writes `config.json` (mode `0600`) from the environment.
Subsequent changes come from the config page and survive restarts. `BRIDGE_TOKEN`
stays in the environment and is never written to `config.json`. qBittorrent
credentials are optional at boot: the proxy starts with an unconfigured client
and answers `/api/health`, `/api/torrents*` and `/archive/*` with `503` until
credentials are saved. Pressing **Save** on the config page activates the
qBittorrent client without a restart.

## Local development

```bash
cp .env.example .env
# edit .env
set -a && . ./.env && set +a
cargo run
```

Open <http://127.0.0.1:8080/>, paste `BRIDGE_TOKEN`, and test the connection.

## Docker

Images are published to GHCR as
`ghcr.io/elicunninghamdev/remagnet-bridge:latest`; make the package public if
anonymous hosts should be able to pull it without `docker login ghcr.io`. The
compose file in this directory points at that image and also has a `build: .`
fallback, so either path works:

```bash
docker compose pull
docker compose up -d
# or build the local source
docker compose up -d --build
```

The compose file expects the external `media` network shared with Caddy and
qBittorrent/gluetun. For a standalone host without that network, remove the
`networks` block, publish port `8080`, and set `QBIT_BASE_URL` to an address the
container can reach. The root README has a complete
[Docker Compose quick start](../README.md#quick-start).

The bind mount is owned by the container's `bridge` user (UID 10001). Create it
before the first start, or replace it with a named volume:

```bash
mkdir -p data
sudo chown 10001:10001 data
```

Put the service behind a local-only reverse-proxy route, for example:

```caddyfile
@remagnet host remagnet.example.com
handle @remagnet {
    import local_only
    reverse_proxy remagnet-bridge:8080
}
```

Pair the extension from the config page's **Pair a device** panel, or enter
`https://remagnet.example.com` and the same token under **Settings → Remagnet
Proxy**.

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
