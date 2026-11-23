# @remagnet/extension

WXT + SolidJS browser extension. The background context is the only part that
talks to the Remagnet Proxy; popup, add and options pages send typed messages to
it (see `lib/messages.ts` and `lib/torrent-service.ts`).

## Architecture

The extension is proxy-only. It never talks to qBittorrent and stores no
qBittorrent credentials:

```
lib/settings.ts          Proxy URL plus the encrypted proxy token
lib/torrent-service.ts   Background facade over @remagnet/proxy-client
lib/pairing.ts           Claims remagnet://pair links (pairing v2)
lib/torrents.ts          Neutral torrent shape shared with the UI
```

`@remagnet/proxy-client` is generated from `proxy/openapi.yaml`, so the
extension calls typed `/api/torrents*`, `/api/health` and `/archive/*` endpoints.
The proxy owns the qBittorrent connection and the category/tags applied to new
magnets; there is no local client adapter, auth-mode choice or per-client
catalog. The extension requests host access to one origin: the configured proxy.

Completed rows always get a **Download** button. Category/tags selection and any
other qBittorrent settings live on the proxy, so every client agrees on what
Remagnet owns.

## Component gallery

`entrypoints/gallery/` is a development-only page at `/gallery.html` that
renders the real components against fixed fixtures from `gallery/fixtures.ts`.
Use it to review hover and removal states, compare the popover's dark theme with
the light pages, and capture before/after screenshots without a torrent client.
It is skipped in `wxt build`; set `REMAGNET_GALLERY=1` to include it in a build.

When changing a component:

1. Add or update its fixture in `gallery/fixtures.ts`.
2. Add a specimen to the matching gallery section.
3. Render it in the browser and check the state at the production width.
4. Add a Vitest assertion in `components/*.test.tsx`.

The gallery and tests use the same props-driven components, so a state that
cannot be rendered there is a sign the component still reads storage or the
background worker directly. `bun run test:ui` runs the Vitest component suite;
`bun run test` runs both it and the Bun unit tests.

## ZIP downloads

Completed rows always get a **Download** button. The background worker validates
the torrent through the proxy, asks the browser to download
`/archive/<info-hash>` and attaches `Authorization: Bearer <token>` in Firefox;
other browsers use the proxy's `?token=` fallback. The proxy itself lives in
`proxy/` (Rust/axum) and is documented there.

Every proxy request, including the list, add and remove calls, goes through
`@remagnet/proxy-client`, whose types and fetch wrapper are generated from
`proxy/openapi.yaml`. Run `bun run api:generate` at the repository root after
changing the spec; archive URLs still come from the shared client because the
browser download API needs a URL rather than a fetched response.

## Popup behavior

The toolbar popover is the only normal UI surface: it lists downloaded torrents
and is also where magnets are reviewed and added (the **Add** button switches it
to the add view). A separate window is never opened, so clicking a magnet does
not cover or replace the page you were reading.

- Each torrent is one flat row: name, bar, then live stats with **Download** and
  remove on the right. The percentage sits at the bar's right end as a 3×5
  tile-font counter that pops only the tiles that change, and the bar's fill
  color carries the status (blue downloading, ochre stalled or zipping, sage
  ready, gray paused or errored); stalled, paused and errored rows say so in the
  space the Download action would use.
  The bar fills while downloading, sweeps while the ZIP is prepared and finishes
  with the completed state. Opening the popover starts at the torrent's current
  progress, so the fill and the completed sweep only animate on real progress or
  state changes.
- The interface is set in bundled Geist Mono on every surface. The shared
  `Wordmark` component places the application icon beside the Remagnet mark in
  bundled Departure Mono, with an optional surface label (Settings, Add torrent,
  Components, Bridge). Both fonts are SIL OFL 1.1, and the files and licenses
  live in `public/fonts/`.
- The application mark lives in `public/icon/remagnet.svg` with a simplified
  `remagnet-small.svg` for 16px and 32px and for the wordmark; the PNGs beside
  them are generated from those two sources with `resvg`.
- The list contains exactly the torrents the proxy exposes through its
  configured category/tags filter. The extension has no category or tag
  settings and cannot override them.
- **Remove** asks whether to keep or delete the files; the confirmation swaps in
  over the row's stats line, then deletes the torrent through the proxy.
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
2. Open your Remagnet Proxy page and choose **Copy link** in the **Pair a
   device** panel, then paste it into **Remagnet Proxy → Pairing code** and
   choose **Pair**. The extension claims the one-time code and saves the proxy
   URL and token.
3. Click **Allow** on the host-permission prompt. Access is scoped to the proxy
   origin even though the manifest declares optional access to `*://*/*`.
4. Open the popup. It lists the torrents the proxy exposes (`remagnet` by
   default), so other downloads in the same qBittorrent instance stay hidden.

You can enter the proxy URL and token manually instead of pairing. Nowhere in
the extension do you enter a qBittorrent URL, API key, password, category or
tags: the proxy owns all of those. The proxy page also shows a rotating pairing
QR for the phone; each code is single-use, expires after a minute, and requires
an HTTPS proxy origin.

Each row has a **Remove** button with a confirmation that either keeps or
deletes the downloaded files. The background worker also polls the same
proxy-filtered list once a minute and raises a browser notification when a
torrent completes; clicking the notification opens the toolbar popup (falling
back to a small window when the browser cannot open it). The manifest needs the
`alarms` and `notifications` permissions for that. On Linux, notifications
require a notification daemon on the desktop session.

### Magnet links

The Firefox manifest declares a `magnet` protocol handler pointing at
`/add.html#%s`; Chrome gets no handler because it does not support extension
protocol handlers. On the first magnet click Firefox asks which application to
use:

1. Choose **Remagnet** and tick **Always use this application**.
2. The handler page hands the magnet to the toolbar popover and returns the tab
   to the page it came from (or closes the throwaway tab). If the popover cannot
   be opened, the full add page remains as a fallback.
3. If the proxy already reports the magnet's info hash, the popover stays on
   the normal torrent list instead of asking to add it again.
4. Otherwise it shows the parsed display name, info hash, size and trackers,
   and checks for an existing info hash before enabling **Send**.
5. The proxy applies its configured category and tags; missing ones are created
   in qBittorrent before the magnet is added. The extension does not choose
   either value.
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

Change the handler under Firefox Settings → Applications (`magnet`).
When editing `protocol_handlers`, stop and restart `dev:firefox`; the handler is
part of the manifest. If the handler is not offered after a dev restart, open
`about:debugging` → **This Firefox** → **Reload** for Remagnet so the manifest
is parsed again.

### Opening popup and options directly

Clicking a toolbar icon is awkward to automate. Print the stable extension
URLs instead:

```bash
bun run urls:firefox   # from the repo root
bun run urls           # from extension/
# popup    moz-extension://<uuid>/popup.html
# add      moz-extension://<uuid>/add.html
# options  moz-extension://<uuid>/options.html
# gallery  moz-extension://<uuid>/gallery.html
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
