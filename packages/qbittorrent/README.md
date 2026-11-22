# @remagnet/qbittorrent

A small, dependency-free TypeScript client for the qBittorrent **Web API v2**.

Supports both authentication methods:

- **API key** (qBittorrent ≥ 5.2 / Web API ≥ 2.14.1) via `Authorization: Bearer`.
  Preferred: stateless, no cookies, no login/logout round-trip.
- **Username/password** cookie authentication, with automatic re-login on expiry.

## Usage

```ts
import { QBittorrentClient } from "@remagnet/qbittorrent";

const qbt = new QBittorrentClient({
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "qbt_...", // or username/password
});

const { appVersion, webApiVersion } = await qbt.testConnection();
await qbt.addTorrent({ urls: ["magnet:?xt=urn:btih:..."], category: "tv" });
const downloading = await qbt.getTorrents({ filter: "downloading" });
```

### Cookie handling

- In a browser/extension, pass `cookieMode: "browser"` and make sure the extension has
  host access to the qBittorrent origin. The browser cookie jar manages `SID`.
- In Bun/Node, `cookieMode: "manual"` (the default outside browsers) parses
  `Set-Cookie` and sends the `SID` cookie explicitly.
- `cookieMode: "auto"` detects the runtime.

### API key limitations

qBittorrent API keys cannot access the Web UI's static files or the `auth/login`
and `auth/logout` endpoints. `login()` and `logout()` are no-ops when an API key is set.

### Password auth behind a reverse proxy or in an extension

qBittorrent's CSRF protection compares the request `Origin` with the `Host` it was
reached through. A browser extension sends `Origin: chrome-extension://…`, which
never matches, so password-mode POSTs are rejected with `403 Forbidden`. API-key
requests are exempt from this check.

If you must use password auth from a non-web context, either:

- use an API key (recommended), or
- disable CSRF in qBittorrent (`WebUI\CSRFProtection=false`) — note this also makes
  the `SID` cookie `SameSite=None`,
- or enable `WebUI\ReverseProxySupport` and list the proxy's subnet in
  `WebUI\ReverseProxySupportWhitelist` so `X-Forwarded-Host` is honoured.

The same setting makes qBittorrent log every proxied client under the proxy's IP
address, which collapses ban tracking and per-IP session limits.

## API surface

Authentication: `login`, `logout`, `testConnection`.

Application: `getAppVersion`, `getWebApiVersion`, `getBuildInfo`, `getPreferences`,
`rotateApiKey`, `deleteApiKey`.

Torrents: `getTorrents`, `addTorrent`, `deleteTorrents`, `stopTorrents`, `startTorrents`,
`recheckTorrents`, `reannounceTorrents`, `getTorrentFiles`, `getTorrentTrackers`,
`addTorrentTrackers`.

`pauseTorrents` and `resumeTorrents` remain as deprecated aliases for
`stopTorrents` and `startTorrents`: qBittorrent 5 removed the `/torrents/pause`
and `/torrents/resume` endpoints in favour of `/torrents/stop` and
`/torrents/start`.

Categories/tags: `getCategories`, `createCategory`, `removeCategories`, `getTags`,
`createTags`, `deleteTags`.

Transfer/sync: `getTransferInfo`, `getMainData`.

Errors are thrown as `QBittorrentError` (HTTP/protocol failures) or
`QBittorrentAuthError` (authentication failures), both exposing `status`, `body`,
and `url`.

## Test

```bash
bun test
```
