# Privacy policy

**Last updated: 22 November 2026**

Remagnet is a local-first browser extension, Android app, and self-hosted proxy.
The project operates no accounts, no analytics, no telemetry, no advertising, and
no servers of its own. Nothing you enter into Remagnet is sent to the project or
to any third party.

## What Remagnet stores

Remagnet only stores the settings you enter, on the device or server where you
entered them.

### Browser extension

- The torrent client URL, username, default category and tags, and the Remagnet
  Proxy URL are kept in the extension's local storage.
- The client API key or password and the Remagnet Proxy token are encrypted with
  AES-GCM before they are written to storage. The key is generated on first use,
  marked non-extractable, and kept in the extension's own IndexedDB.
- Settings stay in that browser profile. They are not synced to a Remagnet
  service.
- On Chrome, a content script runs on pages so the magnet context-menu item can
  appear only when the pointer is over a magnet link. It reads the URL of the
  hovered link and passes it to the extension's own background worker. It does
  not read or collect other page content, and it sends nothing off your device.

### Android app

- Settings are stored in the app's private storage.
- Secrets (the client API key or password and the Remagnet Proxy token) are
  encrypted with a key held by the Android Keystore.
- Pairing codes and scanned QR contents are used in memory and are not saved.
  A successful pairing fills the settings form for you to review before saving.

### Remagnet Proxy

- The proxy keeps `config.json` in its data directory on **your** server. It
  contains the qBittorrent Web UI URL and whichever credentials you saved.
- Files are streamed from qBittorrent to your device as a ZIP and are not copied
  or retained by the proxy.
- Pairing sessions exist only in memory, expire after 60 seconds, are single-use,
  and are discarded when the proxy restarts. The pairing code itself is never
  written to disk or included in request logs.
- The proxy does not log request or response bodies. Its default logs contain
  service startup and shutdown messages; enabling verbose tracing adds ordinary
  request metadata such as method, path, and status.

## Network connections

The extension and the Android app connect only to the torrent client and, if you
configure one, the Remagnet Proxy URL that you provide. The proxy connects only to
the qBittorrent URL that you provide. There are no update checks, crash reports,
remote configuration, or content requests to the project.

Outbound links to GitHub and Ko-fi open in your browser and are governed by those
sites' privacy policies. Remagnet does not include any tracking parameters or
identifiers in those links.

## Permissions

- **Extension storage** keeps the settings described above.
- **Downloads** saves torrent files and completed ZIP downloads.
- **Host access** to websites is declared in Chrome so the magnet context menu can
  tell whether the pointer is over a magnet link. It only inspects the hovered
  link. Access used to call the torrent client and proxy is optional and
  requested only for the origins you enter.
- **Camera** (Android) is used only while you are scanning a pairing QR code.
- **Notifications** (Android) reports magnet additions and download progress.
- **Network access** (Android) reaches your torrent client and proxy.

Remagnet does not use this access to build a history, profile you, or request
access to unrelated services.

## Deleting your data

- Extension: remove the extension or clear its data in your browser's extension
  settings.
- Android: clear the app's storage or uninstall the app.
- Proxy: delete the `config.json` file or the data volume created for the
  container. Outstanding pairing codes disappear when the container stops.

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
