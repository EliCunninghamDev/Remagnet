# Privacy policy

**Last updated: 23 November 2026**

Remagnet is a local-first browser extension, Android app, and self-hosted proxy.
The project operates no accounts, no analytics, no telemetry, no advertising, and
no servers of its own. Nothing you enter into Remagnet is sent to the project or
to any third party.

## What Remagnet stores

Remagnet only stores the settings you enter, on the device or server where you
entered them.

### Browser extension

- The Remagnet Proxy URL is kept in the extension's local storage. The
  per-device proxy token is encrypted with AES-GCM before it is written to
  storage. The key is generated on first use, marked non-extractable, and kept in
  the extension's own IndexedDB. The administrator password and any 2FA code are
  used only during sign-in and are not stored.
- The extension stores no qBittorrent URL, username, API key, password, category
  or tags. Those live only on the Remagnet Proxy.
- Settings stay in that browser profile. They are not synced to a Remagnet
  service.
- On Chrome, a content script runs on pages so the magnet context-menu item can
  appear only when the pointer is over a magnet link. It reads the URL of the
  hovered link and passes it to the extension's own background worker. It does
  not read or collect other page content, and it sends nothing off your device.

### Android app

- Settings are stored in the app's private storage.
- The per-device Remagnet Proxy token is encrypted with a key held by the
  Android Keystore. The proxy URL stays readable so the settings screen can
  render. The administrator password and any 2FA code are used only during
  sign-in and are not stored.
- The app stores no qBittorrent URL, username, API key, password, category or
  tags. Those live only on the Remagnet Proxy.
- Pairing codes and scanned QR contents are used in memory and are not saved.
  A successful pairing saves only the proxy URL and newly minted device token
  and tests the connection.

### Remagnet Proxy

- The proxy keeps `config.json` in its data directory on **your** server. It
  contains the qBittorrent Web UI URL and whichever qBittorrent credentials you
  saved, along with the category/tags applied to Remagnet magnets.
- The proxy keeps `auth.json` beside it (mode `0600`) once you create the
  administrator account. It contains the administrator username and an Argon2id
  password hash, an optional TOTP secret, SHA-256 hashes of any unused recovery
  codes, and the name, id, creation time and last-use time of each device plus a
  SHA-256 hash of its token. The raw password, 2FA codes, recovery codes and
  device tokens are not written to disk.
- Administrator sessions live in the proxy's memory, last seven days, and are
  lost when it restarts. First-run setup and sign-in failures are rate limited in
  memory by client address; the limiter is not persisted or logged.
- Files are streamed from qBittorrent to your device as a ZIP and are not copied
  or retained by the proxy.
- Pairing sessions exist only in memory, expire after 60 seconds, are single-use,
  and are discarded when the proxy restarts. The pairing payload carries only the
  proxy URL and a newly minted device token, never qBittorrent credentials. The
  pairing code itself is never written to disk or included in request logs.
- Archive tickets exist only in memory, expire after 60 seconds, work once, and
  are bound to one torrent hash.
- The proxy does not log request or response bodies. Its default logs contain
  service startup and shutdown messages; enabling verbose tracing adds ordinary
  request metadata such as method, path, and status.

## Network connections

The extension and the Android app connect only to the Remagnet Proxy URL you
provide. The proxy is the only component that connects to qBittorrent, using the
URL and credentials you gave it. There are no update checks, crash reports,
remote configuration, or content requests to the project.

Outbound links to GitHub and Ko-fi open in your browser and are governed by those
sites' privacy policies. Remagnet does not include any tracking parameters or
identifiers in those links.

## Permissions

- **Extension storage** keeps the proxy URL and encrypted token described above.
- **Downloads** saves torrent files and completed ZIP downloads.
- **Host access** to websites is declared in Chrome so the magnet context menu can
  tell whether the pointer is over a magnet link. It only inspects the hovered
  link. Access used to call the Remagnet Proxy is optional and requested only for
  the proxy origin you enter.
- **Camera** (Android) is used only while you are scanning a pairing QR code.
- **Notifications** (Android) reports magnet additions and download progress.
- **Network access** (Android) reaches your Remagnet Proxy.

Remagnet does not use this access to build a history, profile you, or request
access to unrelated services.

## Deleting your data

- Extension: remove the extension or clear its data in your browser's extension
  settings.
- Android: clear the app's storage or uninstall the app.
- Proxy: delete the `config.json` and `auth.json` files or the data volume
  created for the container. Outstanding pairing codes, sessions and archive
  tickets disappear when the container stops.

Remagnet holds no copy of any of this, so there is nothing to request from the
project.

## Children

Remagnet is a utility for managing torrents and is not directed at children. It
does not knowingly collect information from anyone.

## Changes

Material changes to this policy will be published in this file with a new date.
Because Remagnet has no telemetry, the current version of this document is the
complete description of its data practices.

## Contact

Questions about this policy can be sent to
[contact@elijahcunningham.dev](mailto:contact@elijahcunningham.dev) or raised at
[github.com/EliCunninghamDev/Remagnet/issues](https://github.com/EliCunninghamDev/Remagnet/issues).
