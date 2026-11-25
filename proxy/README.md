# Remagnet Proxy

The Remagnet proxy is the required adapter between the browser extension or
Android client and your torrent client. It supports qBittorrent, Transmission,
Deluge, and rTorrent / ruTorrent. It adds, lists, filters and removes torrents
through the client's API and turns completed torrents into ZIP streams.
qBittorrent files are streamed from its Web API; Transmission, Deluge, and
rTorrent read from a read-only downloads mount. Archives are never stored.
Clients only ever hold a per-device proxy token; torrent-client credentials and
the administrator password stay on this service.

## Authentication

The proxy has one administrator account and any number of device tokens.

- **Administrator session.** First boot asks for an administrator username and
  password; the password is hashed with Argon2id. Sign-in sets
  `remagnet_session`, an `HttpOnly; SameSite=Strict` cookie that is `Secure`
  when the request arrived over HTTPS. Sessions live in memory for seven days
  and are revoked on sign-out or password change. Administrative routes
  (`/api/config`, `/api/pair*`, `/api/devices*` and the account routes) accept
  only this session. Repeated sign-in failures are rate limited.
- **Two-factor authentication (optional).** The proxy page can enrol a TOTP
  authenticator and shows eight single-use recovery codes exactly once. Sign-in
  asks for a 6-digit code or a recovery code only when 2FA is enabled.
- **Per-device tokens.** Direct sign-in from the extension or Android app
  (`POST /api/auth/device` with the admin username/password and, when enabled, a
  TOTP or recovery code) and pairing both mint an `rmg_…` token. Only its
  SHA-256 hash is stored, alongside a device name and timestamps; the raw token
  is shown once. Device tokens reach the client endpoints (`/api/health`,
  `/api/torrents*`, the archive ticket and the archive download) and cannot
  reach administrative routes. Revoking a device in the proxy page deletes its
  record and immediately invalidates the token.
- **Pairing without 2FA.** `POST /api/pair` requires an administrator session
  and returns a 60-second, single-use `remagnet://pair` link and QR code.
  Claiming it needs no password or second factor: possession of the code is the
  proof of presence. The response carries a newly minted device token encrypted
  with AES-256-GCM under a key derived from the code and session id, so request
  logs are not enough to recover it. Torrent-client credentials are never part
  of the payload.
- **Archive tickets.** `POST /api/archive/{hash}/ticket` issues a 60-second,
  single-use ticket bound to one info hash. Browsers that cannot attach an
  `Authorization` header use `GET /archive/{hash}?ticket=…`; the ticket is
  consumed by the download, so the long-lived device token never appears in a
  URL, history entry or download log.

## Endpoints

| Endpoint                           | Auth             | Purpose                                                       |
| ---------------------------------- | ---------------- | ------------------------------------------------------------- |
| `GET /`                            | none             | Proxy page: setup, sign-in, settings, pairing and devices     |
| `GET /assets/departure-mono.woff2` | none             | Wordmark font used by the proxy page                          |
| `GET /healthz`                     | none             | Liveness probe                                                |
| `GET /api/auth/status`             | none             | Setup and sign-in state                                       |
| `POST /api/auth/setup`             | none             | Create the administrator account                              |
| `POST /api/auth/login`             | none             | Sign in (password plus optional TOTP/recovery code)           |
| `POST /api/auth/logout`            | session          | Revoke the current administrator session                      |
| `POST /api/auth/password`          | session          | Change the administrator password                             |
| `POST /api/auth/2fa/setup`         | session          | Start TOTP enrolment                                          |
| `POST /api/auth/2fa/enable`        | session          | Confirm TOTP and return recovery codes                        |
| `POST /api/auth/2fa/disable`       | session          | Disable TOTP                                                  |
| `POST /api/auth/device`            | none             | Exchange credentials for a per-device token                   |
| `GET /api/devices`                 | session          | List device records                                           |
| `DELETE /api/devices/current`      | device           | Revoke the caller's own device token (self-service logout)    |
| `DELETE /api/devices/:id`          | session          | Revoke any device token                                       |
| `GET /api/health`                  | device           | API/proxy version, capabilities, defaults and client versions |
| `GET /api/config`                  | session          | Read non-secret settings                                      |
| `PUT /api/config`                  | session          | Update the client URL, credentials and magnet defaults        |
| `GET /api/torrents`                | device           | List torrents owned by Remagnet                               |
| `POST /api/torrents`               | device           | Add magnets with the configured category/tags                 |
| `GET /api/torrents/:hash`          | device           | Read one torrent, unfiltered                                  |
| `DELETE /api/torrents/:hash`       | device           | Remove a torrent owned by Remagnet                            |
| `POST /api/pair`                   | session          | Mint a short-lived pairing code and QR                        |
| `DELETE /api/pair/:id`             | session          | Revoke a pairing code                                         |
| `POST /api/pair/claim`             | none             | Claim a code; returns an encrypted device token               |
| `POST /api/archive/:hash/ticket`   | device           | Mint a single-use archive download ticket                     |
| `GET /archive/:hash`               | device or ticket | Stream a completed torrent as a ZIP                           |

`Authorization: Bearer rmg_…` is the normal device credential. The archive
route additionally accepts `?ticket=…`, and an administrator session cookie is
accepted anywhere a device token is, including the archive download.

The proxy is the only component that talks to the torrent client. It owns the
client credentials and the category/labels applied to Remagnet magnets, exposes
neutral torrent endpoints, and keeps those credentials off the extension and
Android client. `GET /api/torrents` filters by the configured category/tags;
`POST /api/torrents` always applies them and ignores any client-supplied values;
`DELETE /api/torrents/:hash`, `POST /api/archive/:hash/ticket` and `GET
/archive/:hash` refuse torrents outside that filter with `404`. All `/api/*`
responses include `Cache-Control: no-store`.

The proxy page's **Pair a device** panel mints and rotates the code, renders the
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

The proxy page never receives saved secrets back. Leave an API key or password
field blank to keep the saved value; use the matching checkbox to clear it. The
same page creates the administrator account, manages TOTP and recovery codes,
lists and revokes devices, and shows the pairing QR and link.

The page uses the same Remagnet wordmark as the extension. Departure Mono is
bundled at `src/departure-mono.woff2` under the SIL OFL 1.1
(`src/OFL-DepartureMono.txt`); keep that copy in sync with
`extension/public/fonts/departure-mono-regular.woff2`.

## Configuration

Environment variables:

| Variable                              | Default        | Notes                                                                                                                                                       |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_CODE`                          | empty          | Optional one-time code required to create the admin account.                                                                                                |
| `CLIENT_KIND`                         | `qbittorrent`  | `qbittorrent`, `transmission`, `deluge`, or `rtorrent`; `rutorrent` is an alias for `rtorrent`.                                                             |
| `CLIENT_BASE_URL`                     | per client     | Client API URL. Defaults: `http://gluetun:8080`, `http://transmission:9091`, `http://deluge:8112`, or `http://rtorrent:8000`.                               |
| `QBIT_API_KEY`                        | empty          | qBittorrent 5.2+ API key.                                                                                                                                   |
| `CLIENT_USERNAME` / `CLIENT_PASSWORD` | empty          | Shared credentials: qBittorrent fallback login, Transmission, and rTorrent HTTP Basic Auth.                                                                 |
| `DELUGE_PASSWORD`                     | empty          | Deluge Web UI password; used when `CLIENT_PASSWORD` is blank.                                                                                               |
| `DOWNLOADS_DIR`                       | empty          | Read-only mount of the client's completed files. Required for ZIP archives from Transmission, Deluge, and rTorrent; qBittorrent can stream through its API. |
| `CLIENT_DOWNLOADS_DIR`                | empty          | Prefix of save paths as the client reports them, stripped before resolving inside `DOWNLOADS_DIR`.                                                          |
| `REMAGNET_CATEGORY`                   | `remagnet`     | Category or label applied to added magnets and used for listing. Ignored by Transmission.                                                                   |
| `REMAGNET_TAGS`                       | `remagnet`     | Comma-separated tags (labels for Transmission) applied and used for filtering. Ignored by Deluge and rTorrent.                                              |
| `DATA_DIR`                            | `/data`        | `config.json` and `auth.json` live here.                                                                                                                    |
| `BIND_ADDR`                           | `0.0.0.0:8080` | HTTP listen address.                                                                                                                                        |

`CLIENT_KIND` selects the adapter. qBittorrent uses categories and tags,
Transmission uses tags as labels and ignores the category, Deluge uses a single
label from the category and ignores tags, and rTorrent / ruTorrent stores the
category in its `custom1` label and ignores tags. See `.env.example` for each
client's recommended values.

Set `SETUP_CODE` only while the first boot is reachable from an untrusted
network: it prevents a stranger from claiming the administrator account. Remove
it once the account exists; it is ignored after that.

The first boot writes `config.json` (mode `0600`) from the environment.
Subsequent changes come from the proxy page and survive restarts. Account data
goes to `auth.json` (also mode `0600`) when the administrator account or the
first device is created: an Argon2id password hash, an optional TOTP secret and
recovery-code hashes, and SHA-256 hashes of device tokens. Raw passwords, TOTP
codes, recovery codes and device tokens are never written there. Torrent-client
credentials follow the selected client: qBittorrent needs an API key or
username, Transmission and rTorrent need only a URL unless their endpoint
requires authentication, and Deluge also needs its password. The proxy starts
with an unconfigured client and answers `/api/health`, `/api/torrents*` and
`/archive/*` with `503` until credentials are saved. Pressing **Save** on the
proxy page activates the selected client without a restart.

## Local development

```bash
cp .env.example .env
# edit .env, optionally setting SETUP_CODE and torrent-client bootstrap values
set -a && . ./.env && set +a
cargo run
```

Open <http://127.0.0.1:8080/>, create the administrator account, and test the
torrent-client connection. Leave `SETUP_CODE` empty on a local-only machine.

## Docker

Images are published to GHCR as
`ghcr.io/elicunninghamdev/remagnet-proxy:latest`; make the package public if
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
your torrent client or gluetun. For a standalone host without that network, remove the
`networks` block, publish port `8080`, and set `CLIENT_BASE_URL` to an address the
container can reach. The root README has a complete
[Docker Compose quick start](../README.md#quick-start).

The bind mount is owned by the container's `remagnet` user (UID 10001). Create
it before the first start, or replace it with a named volume:

```bash
mkdir -p data
sudo chown 10001:10001 data
```

Put the service behind a local-only reverse-proxy route, for example:

```caddyfile
@remagnet host remagnet.example.com
handle @remagnet {
    import local_only
    reverse_proxy remagnet-proxy:8080
}
```

Pair the extension from the proxy page's **Pair a device** panel, or sign in with
your administrator username and password under **Settings → Remagnet Proxy**.
Pairing works without a 2FA code; direct sign-in asks for one only when
two-factor authentication is enabled.

## How archiving works

1. Look up the torrent by info hash and require `progress == 1`.
2. List its files through the client API.
3. For qBittorrent 5.2+, fetch each file with `torrents/downloadFile`. For
   Transmission, Deluge, and rTorrent, resolve each file inside the read-only
   `DOWNLOADS_DIR` mount. Copy the bytes into a stored (uncompressed) ZIP entry
   with a data descriptor.
4. Stream the ZIP body back to the browser without buffering the archive.
5. If an upstream file stream fails mid-way, the HTTP body is aborted rather
   than ending cleanly. Without that, browsers save a truncated ZIP as a
   completed download because the response has no `Content-Length`.

Media files do not benefit from ZIP compression, so entries use `Stored`.
Upstream requests have no total deadline (archives can take a long time), but a
60-second read timeout still catches stalled connections.

## Tests

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```
