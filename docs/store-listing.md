# Browser Store Submission Kit

Copy-paste metadata, permission justifications, and reviewer notes for **Firefox Add-ons (AMO)** and the **Chrome Web Store (CWS)**.

## Core listing fields

| Field                                                                                 | Value                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Name**                                                                              | `Remagnet`                                                                                               |
| **Short description / Summary** (103 chars — fits CWS 132-char & AMO 250-char limits) | `Forward magnet links to your self-hosted Remagnet Proxy and stream completed torrents as ZIP archives.` |
| **Category**                                                                          | Productivity / Download Management                                                                       |
| **Homepage URL**                                                                      | `https://remagnet.app`                                                                                   |
| **Privacy Policy URL**                                                                | `https://remagnet.app/privacy.html`                                                                      |
| **Support URL**                                                                       | `https://github.com/EliCunninghamDev/Remagnet/issues`                                                    |
| **Source repository**                                                                 | `https://github.com/EliCunninghamDev/Remagnet`                                                           |
| **License**                                                                           | `Apache-2.0`                                                                                             |
| **Firefox Gecko ID**                                                                  | `extension@remagnet.app`                                                                                 |

### Detailed description

> Remagnet connects Firefox and Chrome to your self-hosted Remagnet Proxy so you can send magnet links to your torrent client and pull finished torrents back to your device as streamed ZIP archives—without ever exposing qBittorrent or Transmission directly to the internet.
>
> **Features**
> - **One-click magnet forwarding:** Click any `magnet:` link in Firefox (registered as a protocol handler) or right-click a magnet link in Chrome to inspect its name, infohash, and trackers before sending it.
> - **Live progress & notifications:** Check active and completed Remagnet torrents from the toolbar popup and receive desktop notifications when downloads finish.
> - **Streamed ZIP downloads:** Download completed torrents straight through your browser's download manager as uncompressed ZIP archives streamed directly from your proxy.
> - **Scoped per-device authentication:** Sign in with your proxy administrator credentials (including optional TOTP 2FA) or paste a single-use 60-second pairing link to mint a revocable device token (`rmg_…`). Your password, 2FA code, and torrent client credentials are never stored in the extension.
> - **Local-first & zero telemetry:** Connects only to the self-hosted Remagnet Proxy URL you configure. No accounts, no analytics, and no external servers.
>
> **Requirements**
> Requires a self-hosted Remagnet Proxy instance (Docker image `ghcr.io/elicunninghamdev/remagnet-proxy`). Setup guide and documentation: https://remagnet.app

---

## Chrome Web Store — Single-purpose & permission justifications

### Single-purpose description

> Remagnet forwards user-selected `magnet:` links to the user's self-hosted Remagnet Proxy, monitors the progress of torrents added through Remagnet, and downloads completed Remagnet torrents as ZIP archives.

### Permission justifications

| Permission                                                | Justification                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                                 | Stores the user's configured Remagnet Proxy URL, notification preferences, and AES-GCM encrypted per-device bearer token locally in the browser profile.                                                                                                                                                                                                                                                                                   |
| `downloads`                                               | Triggers browser downloads when the user clicks "Download ZIP" on a completed torrent, streaming the archive from the user's Remagnet Proxy (using a single-use 60-second ticket so bearer tokens never appear in URLs).                                                                                                                                                                                                                   |
| `alarms`                                                  | Periodically polls the user's configured Remagnet Proxy while torrents are active so completion notifications can fire even when the popup is closed.                                                                                                                                                                                                                                                                                      |
| `notifications`                                           | Displays a browser notification when a torrent monitored by Remagnet finishes downloading on the remote client.                                                                                                                                                                                                                                                                                                                            |
| `contextMenus` (Chrome only)                              | Adds an "Add to Remagnet" item to the link context menu so Chrome users can forward `magnet:` links (Chrome does not allow extensions to register `magnet:` protocol handlers).                                                                                                                                                                                                                                                            |
| Optional host permissions (`*://*/*`)                     | Users self-host Remagnet Proxy on arbitrary private or public domains/ports. The manifest declares `*://*/*` as optional, and at runtime the extension requests host access strictly narrowed to the single origin entered in Settings.                                                                                                                                                                                                    |
| Content script (`http://*/*`, `https://*/*`, Chrome only) | Chrome MV3's `contextMenus.create({ targetUrlPatterns })` rejects the `magnet:` scheme. A minimal content script (`entrypoints/context-link.content.ts`) inspects only the `href` of the link currently under the pointer on `pointerover`/`contextmenu` and notifies the background worker to show or hide the "Add to Remagnet" context menu item. It does not read other page content, modify the DOM, or transmit data off the device. |

### Data usage / privacy disclosures

- **Collects user data?** No.
- **Certifies compliance with Limited Use / no sale or transfer to third parties?** Yes.
- **Remote code execution?** No. All JavaScript is bundled in the submitted package.

---

## Firefox Add-ons (AMO) — Reviewer notes & build instructions

### Data collection disclosure

`manifest.json` includes `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]` (`strict_min_version: "142.0"`). Select **"No data collection"** in the AMO submission wizard to match.

### Source build instructions (paste into AMO "Notes to Reviewer")

> This extension is built from TypeScript and SolidJS using WXT and Bun (`packageManager: bun@1.4.5` in `package.json`).
>
> **Environment**
> - OS: Linux (x86_64 or arm64) or macOS
> - Runtime: Bun 1.4.5 (`https://bun.sh`)
>
> **Build steps from the uploaded source archive**
>
> ```bash
> bun install --frozen-lockfile
> bun run build:firefox
> ```
>
> The compiled MV2 extension is written to `extension/.output/firefox-mv2/` (and `bun run zip:firefox` produces the distributable ZIP under `extension/.output/`).
>
> **Testing & lint notes**
> - No third-party servers are contacted; the extension connects only to a user-supplied Remagnet Proxy URL.
> - Optional `*://*/*` permission is never requested globally—Settings requests only the exact origin entered by the user.
> - The Chrome hover content script (`entrypoints/context-link.content.ts`) is skipped during Firefox builds (`wxt.config.ts`) and is absent from both `manifest.json` and the packaged files.
> - `web-ext lint` emits a single `UNSAFE_VAR_ASSIGNMENT` warning on `chunks/Wordmark-*.js` (`t.innerHTML = e`). This is SolidJS's compiled `template()` helper initializing static JSX string literals; Remagnet never assigns user or network data to `innerHTML`.

### Creating the AMO source archive

`bun run zip:firefox` automatically packages the workspace source archive at `extension/.output/remagnet-<version>-sources.zip` (published as `remagnet-<version>-firefox-sources.zip` on GitHub Releases) with the exact files required for `bun install --frozen-lockfile && bun run build:firefox`. CI verifies that rebuilding from this archive matches `extension/.output/firefox-mv2/` byte-for-byte.

---

## Visual asset checklist

Before clicking submit on either store, prepare these assets:

- [x] **Extension icon (`128×128` PNG):** [`extension/public/icon/128.png`](../extension/public/icon/128.png) (plus vector source [`extension/public/icon/remagnet.svg`](../extension/public/icon/remagnet.svg))
- [ ] **Screenshots (`1280×800` PNG, 2–5 images):**
  1. Add-magnet confirmation popover (`add.html`)
  2. Toolbar popup showing active & completed torrents with Download ZIP action
  3. Settings page showing sign-in / pairing link connection status
  4. Remagnet Proxy web UI (optional, shows self-hosted companion)
- [ ] **Chrome Web Store small promo tile (`440×280` PNG, no alpha)**
- [ ] _(Optional)_ **Chrome Web Store marquee promo tile (`1400×560` PNG)**
