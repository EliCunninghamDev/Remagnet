# @remagnet/extension

WXT + SolidJS browser extension. The background context is the only part that
talks to a torrent client; popup, add and options pages send typed messages to
it (see `lib/messages.ts` and `lib/torrent-service.ts`).

## Architecture

qBittorrent is currently the only backend, but everything outside
`lib/clients/` works with client-neutral types:

```
lib/clients/types.ts       Adapter contract and neutral request/response types
lib/clients/catalog.ts     Static client metadata used by the settings UI
lib/clients/qbittorrent.ts qBittorrent adapter (wraps @remagnet/qbittorrent)
lib/clients/index.ts       Adapter registry, imported by the background only
lib/torrent-service.ts     Background facade: resolve settings, validate, delegate
```

The UI imports `lib/clients/catalog.ts` for labels, auth modes and capabilities,
so client SDKs stay out of page bundles. To add a client:

1. Extend `ClientKind` in `lib/clients/types.ts`.
2. Add a catalog entry with its auth modes, capabilities and validation.
3. Implement the adapter and register its factory in `lib/clients/index.ts`.

The pause field in the add flow is shown from the adapter's `capabilities`, so
clients without it degrade cleanly. Category and tags are applied from settings
automatically, not chosen per torrent.

## ZIP downloads

If **Archive downloads** is configured in settings, completed rows get a **ZIP**
button. The background worker validates the torrent, asks the browser to
download `/archive/<info-hash>` and attaches `Authorization: Bearer <token>` in
Firefox; other browsers use the bridge's `?token=` fallback. The bridge itself
lives in `services/archive-bridge/` (Rust/axum) and is documented there.

## Popup behavior

The toolbar popover is the only normal UI surface: it lists downloaded torrents
and is also where magnets are reviewed and added (the **Add** button switches it
to the add view). A separate window is never opened, so clicking a magnet does
not cover or replace the page you were reading.

- Each torrent gets a square-cell progress bar and a small state label; the bar
  fills while downloading, sweeps while the ZIP is prepared and finishes with the
  completed state. Opening the popover starts at the torrent's current progress,
  so the fill and the completed sweep only animate on real progress or state
  changes.
- The interface is set in bundled Geist Mono; the Remagnet wordmark uses bundled
  Departure Mono. Both are SIL OFL 1.1, and the font files and licenses live in
  `public/fonts/`.
- The list is filtered to the configured default category/tags. With both
  defaults blank, filtering is disabled because there is no way to tell which
  torrents belong to Remagnet.
- **Remove** asks whether to keep or delete the files, then deletes the torrent
  through the client adapter.
- While open, the popover polls the list once a second while any torrent is
  still downloading (every five seconds when everything is complete), so the
  bars and speed readouts stay live. Requests are serialized, and polling pauses
  while the add view is showing. The background worker polls once a minute even
  when the popover is closed and shows a notification when a tracked torrent
  completes.

## Firefox development loop

Firefox is the primary target while the UI is being built.

```bash
bun install
bun run dev:firefox        # from the repo root, or `bun run dev:firefox` here
```

WXT builds to `.output/firefox-mv2-dev` and starts Firefox with a temporary
add-on install. Dev runs share a persistent profile at
`.dev/firefox-profile/` (gitignored), so settings and granted host permissions
survive restarts.

### First run

1. Open the options page (see below) or right-click the toolbar button →
   **Settings**.
2. Pick the client (currently qBittorrent), enter the Web UI URL, e.g.
   `https://qbt.example.com`, and auth (API key recommended; qBittorrent 5.2+).
3. Set the default category and tags used by the add flow. Both default to
   `remagnet`.
4. Click **Save & test connection** and click **Allow** on the permission
   prompt. The prompt is scoped to the configured host even though the manifest
   declares optional access to `*://*/*`.
5. Open the popup. It lists only torrents whose category or tags match the
   defaults from step 3 (`remagnet` unless changed), so other downloads in the
   same client stay hidden.

Each row has a **Remove** button with a confirmation that either keeps or
deletes the downloaded files. The background worker also polls the same filtered
list once a minute and raises a browser notification when a torrent completes;
clicking the notification opens the toolbar popup (falling back to a small
window when the browser cannot open it). The manifest needs the `alarms` and
`notifications` permissions for that. On Linux, notifications require a
notification daemon on the desktop session.

### Magnet links

The Firefox manifest declares a `magnet` protocol handler pointing at
`/add.html#%s`; Chrome gets no handler because it does not support extension
protocol handlers. On the first magnet click Firefox asks which application to
use:

1. Choose **Remagnet** and tick **Always use this application**.
2. The handler page hands the magnet to the toolbar popover and returns the tab
   to the page it came from (or closes the throwaway tab). If the popover cannot
   be opened, the full add page remains as a fallback.
3. If the client already has the magnet's info hash, the popover just stays on
   the normal torrent list instead of asking to add it again.
4. Otherwise it shows the parsed display name, info hash, size and trackers,
   and checks for an existing info hash before enabling **Send**.
5. Category and tags are applied automatically from settings; missing ones are
   created in the client before the torrent is added.
6. After a successful add the popover returns to the torrent list directly; the
   new torrent shows up as soon as the next refresh picks it up.
7. Use the popover's **Add** button for pasted magnets, or in Chrome for every
   add.

Chrome has no extension protocol handlers. There, right-click a magnet link and
choose **Add to Remagnet**, or use the popover's **Add** button; both open the
same review screen. The menu item only appears on magnet links: Chrome cannot
inspect the right-click before the menu is built, so a small content script
reports the hovered link to the background, which shows or hides the item. That
content script is Chrome-only; Firefox uses the protocol handler and asks for no
page access. If the item is ever shown on a non-magnet link (for example after
the extension was reloaded without refreshing the page), clicking it explains
why nothing was added.

Change the handler later under Firefox Settings → Applications (`magnet`).
When editing `protocol_handlers`, stop and restart `dev:firefox`; the handler is
part of the manifest. If the handler is not offered after a dev restart, open
`about:debugging` → **This Firefox** → **Reload** for Remagnet so the manifest
is parsed again.

### Opening popup and options directly

Clicking a toolbar icon is awkward to automate. Print the stable extension
URLs instead:

```bash
bun run urls:firefox   # from the repo root
bun run urls           # from apps/extension
# popup    moz-extension://<uuid>/popup.html
# add      moz-extension://<uuid>/add.html
# options  moz-extension://<uuid>/options.html
```

The UUID comes from the dev profile's `prefs.js`. `about:debugging#/runtime/this-firefox`
shows the same internal UUID.

### Reload behavior

- Source edits hot-reload the extension.
- Reopen the popup after changing popup code; an open popup is a separate page.
- **Manifest changes** (permissions, ID, commands) only apply on a fresh
  `web-ext` launch. Stop and restart `dev:firefox` after editing
  `wxt.config.ts`.
- `about:debugging` also has a **Reload** button, but it does not reinstall an
  updated manifest.

### Permission quirk

The manifest declares `*://*/*` as an optional host permission, then requests
the exact origin from settings at runtime. Two Firefox behaviors matter:

- `<all_urls>` is silently removed from `optional_permissions`; requesting it
  then fails with "not declared in the manifest". Use `*://*/*`.
- The requested pattern must be a subset of the declared wildcard; the reverse
  does not work.

## Headless / automated runs

The extension is a normal Firefox add-on, so it runs under Xvfb:

```bash
xvfb-run -a bun run dev:firefox
```

For scripted checks, prefer opening `moz-extension://<uuid>/popup.html` from
`bun run urls:firefox` in a tab, then assert on the rendered list instead of
trying to click the toolbar icon.

## Other browsers

```bash
bun run dev            # Chrome (MV3)
bun run build          # Chrome production build
bun run build:firefox  # Firefox production build
```

Chrome accepts a subset of the optional host permission directly, so it only
ever prompts for the configured origin.
