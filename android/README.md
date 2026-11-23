# Remagnet for Android

Kotlin/Jetpack Compose client for Android. It handles magnet links and talks
only to the Remagnet Proxy, which adds, lists and removes torrents in qBittorrent
and streams completed torrents as ZIPs. The proxy owns the qBittorrent
credentials and the category/tags that mark Remagnet torrents; the phone stores
only the proxy URL and token.

The build is landing in phases. [`PLAN.md`](PLAN.md) is the full plan, including
CI and release signing; this README covers what is implemented today.

## Current status

Phases 1-4 are complete:

- A single connection screen for the Remagnet Proxy URL and token.
- Settings validation, with the same URL and token checks as the browser
  extension, before anything is saved.
- Encrypted proxy-token storage using the Android Keystore; the URL stays
  readable so settings can render.
- One-step `remagnet://pair` v2 onboarding: scan the rotating code, claim it from
  the proxy, decrypt the payload, and save the proxy URL and token. A paste
  fallback covers devices without a camera.
- QR import for `remagnet://connect` links and JSON codes carrying a proxy URL
  and token, with a review step before saving.
- `ProxyTorrentClient`, a generated-Retrofit adapter for the proxy's neutral
  torrent API: health, list, lookup, add and remove. There is no direct
  qBittorrent client in the app.
- Neutral torrent models and proxy state normalization. The proxy applies and
  filters by category/tags, so the app has no local category or tag settings.
- A proxy health check that distinguishes an unreachable proxy, a bad token and
  a proxy whose own qBittorrent connection is failing.
- Magnet intake from `VIEW magnet:` links and shared `text/plain` text, with a
  review sheet over the home screen.
- Duplicate detection through the proxy, the proxy-owned category/tag defaults,
  pause-on-add, and retry after a rejected or failed add.
- Intent and draft state kept in saved state, so a review survives rotation and
  process death.
- A torrent list with the shared square-cell bar, percentage counter, state
  colors and live stats, refreshed only while the home screen is visible.
- Removal with keep-files and delete-files choices through the proxy.
- Always-available ZIP downloads for completed torrents in a foreground service,
  with a live notification and cancel and retry actions. Both the proxy URL and
  token are required, so a configured app can always download.
- Bundled Geist Mono and Departure Mono, so Android matches the browser
  clients.

```
android/
  app/                     Application module (Compose)
  app/src/main/java/dev/remagnet/app/
    MainActivity.kt        Entry point and Compose host
    data/                  Settings, encrypted storage, onboarding payloads
    client/                ProxyTorrentClient, proxy health, neutral models
    magnet/                Magnet parser, intent extraction, VIEW/SEND intake
    download/              Archive streaming service, naming and notifications
    proxy/ProxyApi.kt      Configures the generated Retrofit client
    ui/                    Screens, add sheet, theme and shared controls
    ui/components/         Square bar, controls and shared panels
    util/Format.kt         Byte, speed, percentage and ETA formatting
  proxy-client/            Generated Kotlin/Retrofit proxy client (library)
  gradle/libs.versions.toml Version catalog
  PLAN.md                  Phased buildout, CI and signing notes
```

## Settings

The settings screen accepts only the proxy connection:

| Setting              | Notes                                                          |
| -------------------- | -------------------------------------------------------------- |
| Remagnet Proxy URL   | `http://` or `https://`, no credentials, query or fragment     |
| Remagnet Proxy token | At least 16 characters; encrypted before it is written to disk |

Both fields are required. There is no qBittorrent URL, API key, password,
category or tags on the device: those are configured on the proxy, which applies
its category/tag defaults to every add and uses them to filter list and remove
requests.

Inside the emulator, use `http://10.0.2.2:8080` to reach a proxy on the host. A
deployed instance normally uses an HTTPS URL. Saving validates the whole form,
writes the settings, and immediately refreshes the torrent list and checks the
proxy. The home screen lists torrents, while the connection form and its status
are part of the settings screen.

## Proxy client

`client/ProxyTorrentClient.kt` implements the app's torrent contract against the
generated Retrofit client:

| Operation    | Proxy endpoint                |
| ------------ | ----------------------------- |
| Health       | `GET /api/health`             |
| List         | `GET /api/torrents`           |
| Lookup       | `GET /api/torrents/{hash}`    |
| Add          | `POST /api/torrents`          |
| Remove       | `DELETE /api/torrents/{hash}` |
| Download ZIP | `GET /archive/{hash}`         |

The bearer token is attached by `ProxyApi` through the generated `bearerAuth`
interceptor. Every method returns `QbitResult`: `Success` with a neutral model,
or `Failure` with a typed `QbitError` (invalid settings, unauthorized,
unreachable, HTTP, rejected torrent, unreadable response). Screens render those
states directly; there is no spinner that can hang.

The proxy applies its category and tags when a magnet is added, creates missing
ones in qBittorrent, and refuses to remove torrents outside that filter. The app
never sends category or tag values and never sees qBittorrent credentials.

## Magnet intake and review

The activity registers two intake paths:

| Intent                   | Data                         | Use                                         |
| ------------------------ | ---------------------------- | ------------------------------------------- |
| `VIEW`                   | `magnet:` URI                | A magnet link opened from a browser         |
| `SEND` / `SEND_MULTIPLE` | `text/plain` in `EXTRA_TEXT` | A magnet shared from a chat or file manager |

`MainActivity` uses `singleTop`, so a link opened while the app is already
running arrives through `onNewIntent` instead of stacking a second copy. The
magnet is read from the intent's data first, then from the first magnet found in
shared text. Quotes, brackets and trailing punctuation around a shared link are
stripped. A link without a BitTorrent v1 hash opens the sheet in paste mode with
an explanation, so the user can correct it instead of losing the share.

The parser normalizes base32 info hashes to hex, decodes `+` as a space in query
values, reads `xl` only when it is all digits, and collects `tr` trackers and
`ws` web seeds. It matches the extension's parser, including the label and
tracker-host helpers.

The review sheet is a Material 3 modal over the home screen:

- It shows the display name, info hash, size, tracker hosts and web-seed count.
- It asks the proxy for the hash before enabling **Send**. An existing torrent is
  named in the warning and blocks the add. A lookup failure still allows the
  attempt and explains that duplicates could not be checked.
- The proxy's category and tags are shown and applied by the proxy; **Add paused**
  sends the torrent stopped.
- A rejected or failed add keeps the magnet and its settings in the sheet, with
  the error visible. Pressing **Send** again retries the same link.
- A successful add shows the name, category and tags, with **Add another** and
  **Done** actions.
- With the proxy unconfigured, the link can still be reviewed; sending is
  blocked and **Open settings** goes straight to the connection form.

A pending magnet, the paused choice and an unsent paste draft live in
`SavedStateHandle`. Rotation keeps the sheet in place; process death restores the
review and re-runs the duplicate check. A request that is already sending
refuses to be swiped away or dismissed until it returns. **Add magnet** on the
home screen opens the same sheet in paste mode.

## Torrent list and archive downloads

The home screen lists the torrents the proxy exposes. Each row splits a long
name so the extension stays visible, draws the same square-cell progress bar as
the extension, and shows the percentage counter, state color and live transfer
stats. Rows cover downloading, stalled, queued, checking, moving, seeding,
stopped, error and missing-file states; unknown future states render neutrally
instead of failing.

The list refreshes every five seconds while Home is resumed. Navigating to
Settings, switching apps or locking the phone cancels the current request and
stops the loop, so Remagnet does not poll the proxy in the background. `Retry`
appears when the last refresh failed, and the previous rows stay on screen
instead of being replaced by an error page.

Pressing **Remove** expands a confirmation in the row with **Keep files** and
**Delete files**. Removal is refused while that torrent's own archive is
downloading, and the proxy refuses the request for torrents outside its
configured category/tags.

Completed rows get an always-enabled **Download** action, because the proxy is
the app's only connection. The archive is streamed from `GET /archive/<hash>` by
a foreground service, which keeps the bearer token in a header and reports bytes
and speed. The in-app row and the notification both track the same state:

- Progress is determinate against the torrent size and smoothed over recent
  samples. The Remagnet Proxy streams ZIPs without `Content-Length`, so an
  unknown size falls back to an indeterminate bar.
- **Cancel** stops the stream and deletes the partial file. A cancelled download
  keeps **Retry** and **Dismiss** actions in the row and the notification.
- A failure keeps the Remagnet Proxy or network message, with **Retry** and
  **Dismiss**.
- Completion saves the file, posts a notification with an **Open** action, and
  shows **Open** and **Dismiss** in the row. `OpenArchiveActivity` tries a ZIP
  viewer and falls back to a share sheet when none is installed.
- One archive downloads at a time. A second request shows an action error that
  names the running download instead of queueing silently.

Archives are written to the app-specific external Downloads folder,
`Android/data/dev.remagnet.app/files/Download/Remagnet/`, under a sanitized,
unique name. That location needs no storage permission and is removed when the
app is uninstalled. On Android 13 and newer the app asks for notification
permission the first time a download starts; a download still runs if the user
declines, but progress is only visible inside the app.

## QR onboarding

The primary code is minted by the Remagnet Proxy page's **Pair a device** panel
as a `remagnet://pair` code. The code rotates every minute, works once, and
carries only the proxy URL and a short-lived secret. When the app scans it, it
claims the session and receives a pairing v2 payload encrypted with a key
derived from the scanned code. The decrypted payload is `{ version: 2,
proxyToken }`: the phone gets the proxy URL and token, while qBittorrent
credentials and category/tags stay on the proxy. Pairing requires an HTTPS proxy
origin.

The same link can configure the extension instead: paste it into the extension's
**Remagnet Proxy → Pairing code** field. A code is single-use, so copy a fresh one
for each device.

A `remagnet://connect` code remains available for manually generated codes and
for the paste box. It can carry the proxy URL, token, or both:

```
remagnet://connect?proxy=https%3A%2F%2Fremagnet.example.com&token=...
```

Recognised connect query keys:

| Purpose     | Keys                       |
| ----------- | -------------------------- |
| Proxy URL   | `proxy`, `proxyUrl`, `url` |
| Proxy token | `token`, `proxyToken`      |

The pairing form is:

```
remagnet://pair?url=https%3A%2F%2Fremagnet.example.com&id=...&code=...
```

`id` names the in-memory session on the proxy and `code` is the 32-byte secret.
The app sends only `SHA-256(code)` when claiming; the returned settings are
AES-256-GCM encrypted with a key derived from the secret and id, so a logged
request or response cannot be decrypted without the QR image.

A JSON object with the same connect keys is accepted. A bare `http://` or
`https://` URL is treated as the proxy URL.

Query values use URL encoding with one deliberate exception: `+` stays a plus so
Base64 tokens survive. Encode a space as `%20`, not `+`. The scanner shows the
imported values in the form and writes nothing until **Save settings** is
pressed.

The app asks for camera access the first time a code is scanned. **Paste code**
in the Remagnet Proxy section accepts the same payload without a camera, which is
also the path used in emulator tests.

## Security

The proxy token is encrypted with an AES-256-GCM key generated inside the
Android Keystore. The key is non-exportable and is not tied to biometrics or a
PIN, so background health checks work without an unlock prompt.

The proxy URL stays readable in SharedPreferences so the settings screen can
render without decrypting anything. The Remagnet Proxy token is stored only as
ciphertext in one encrypted JSON value. The app has no qBittorrent URL,
username, password or API key to store: those remain on the proxy.

If the Keystore key is lost (a cleared app, a restored backup, a reset device),
the app treats the ciphertext as absent, removes it, and asks for the secret
again. It does not fail to start or keep retrying a value it can never read.

A copied preference file does not reveal the secrets. Code running as the app
can still decrypt them while the device is unlocked, the same limit the
extension's non-extractable WebCrypto key has.

## Generated proxy client

`proxy-client/src/main/java/dev/remagnet/proxy/` is generated from
`proxy/openapi.yaml` with OpenAPI Generator (`kotlin`, `jvm-retrofit2`,
`gson`). Do not edit those files by hand. The archive endpoint is generated as a
`@Streaming Response<ResponseBody>`, so downloads stream to disk instead of
buffering the ZIP in memory.

`ProxyApi` configures the generated client:

```kotlin
// Inside a coroutine or another suspend function.
val api = ProxyApi("https://remagnet.example.com", token)
val health = api.configuration.checkQbitConnection().body()
```

It uses the generated `bearerAuth` interceptor, so the token is never added as a
query parameter or spliced into individual calls. Regenerate from the repository
root after changing the spec:

```bash
bun run api:generate   # needs JDK 21; also regenerates the TypeScript client
```

Commit generated sources with the spec change so Android builds stay
reproducible without running the generator.

## Toolchain

This checkout is already configured on this machine:

| Component          | Version / location                                  |
| ------------------ | --------------------------------------------------- |
| JDK                | OpenJDK 21 (`/usr/lib/jvm/java-21-openjdk`)         |
| Android SDK        | `~/Android/Sdk` (`ANDROID_HOME`)                    |
| Command-line tools | `~/Android/Sdk/cmdline-tools/latest`                |
| Platform           | Android 37.2 (`compileSdk 37`, minor 2)             |
| Build tools        | 36.0.0                                              |
| Target SDK         | 36, minimum SDK 26                                  |
| Emulator           | 37.3.10, KVM + host GPU                             |
| System image       | Android 36.0 Google APIs, x86_64                    |
| AVD                | `remagnet-api36` (medium phone)                     |
| Gradle             | 9.9.0 via wrapper                                   |
| AGP                | 9.5.2 (built-in Kotlin; no `kotlin-android` plugin) |

Environment variables are set for new fish shells in
`~/.config/fish/conf.d/android.fish` and for GUI-launched apps in
`~/.config/environment.d/90-android.conf`.

Android Studio is optional. Open the `android/` directory as a project; the
Gradle wrapper and version catalog supply everything else.

## Build and test

```bash
cd android
./gradlew :app:assembleDebug      # APK: app/build/outputs/apk/debug/
./gradlew :app:testDebugUnitTest  # JVM unit tests
./gradlew :app:lintDebug          # Android lint
```

From the repository root:

```bash
bun run android:build
bun run android:test
```

Unit tests cover settings validation, encrypted storage round-trips, corrupt
ciphertext recovery, QR parsing, settings merging, pairing decryption, proxy
error mapping, and `ProxyTorrentClient` against an in-process HTTP server. That
server exercises bearer auth, health, list and lookup, add, remove, rejected
magnets and malformed responses. Magnet tests cover hex and base32 hashes, web
seeds, wrapped shared text, `VIEW` and `SEND` intake, duplicate-state mapping,
add-request defaults and byte formatting. Phase 4 adds tests for the shared
tile-bar geometry and counter, archive file naming and unique suffixes,
`Content-Disposition` parsing, proxy error messages, smoothed download speed,
download state transitions, ETA formatting and long-name splitting. They run on
the JVM and do not need an emulator.

## CI

`.github/workflows/android.yml` runs the unit tests and lint, builds a debug APK
and uploads it as an artifact on changes under `android/`, `packages/proxy-client/`
or the proxy contract. Debug builds are signed with the runner's generated debug
key, so they install without repository secrets.

`.github/workflows/release.yml` handles `v*` tags for the whole project. It
runs the Android tests and lint, then builds a signed APK and AAB when all four
signing secrets are configured. Without them it attaches a debug-signed APK so
the release still has an installable Android build.

Release signing needs a keystore kept outside the repository. `PLAN.md` covers
key generation, the Gradle wiring and the environment variables the workflow
uses. `*.jks`, `*.keystore` and `keystore.properties` are ignored.

## Emulator

```bash
emulator -avd remagnet-api36 -gpu host &    # windowed
# Headless / agent use:
emulator -avd remagnet-api36 -no-window -no-audio -no-boot-anim -gpu host &
adb wait-for-device
adb shell getprop sys.boot_completed   # 1 when booted
```

Exercise the two intake paths without a browser:

```bash
adb shell "am start -a android.intent.action.VIEW \
  -d 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test+ISO'"

adb shell "am start -a android.intent.action.SEND -t text/plain \
  --es android.intent.extra.TEXT \
  'Look at this: magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'"
```

`-gpu host` uses the host GPU through XWayland (NVIDIA here) and boots in about
12 seconds. Software rendering is much slower, and the Android 36.1 image's
SurfaceFlinger aborts on this host, so the AVD uses the stable 36.0 image. In a
private headless desktop, `-gpu swiftshader_indirect` also works and takes about
a minute to boot.

Install and launch:

```bash
./gradlew :app:installDebug
adb shell am start -n dev.remagnet.app/.MainActivity
```

The emulator reaches services on the host at `10.0.2.2`. Cleartext HTTP is
allowed only for `10.0.2.2`, `localhost` and `127.0.0.1`
(`app/src/main/res/xml/network_security_config.xml`). For a proxy bound to the
host loopback, either use `http://10.0.2.2:8080` or forward the port:

```bash
adb reverse tcp:8080 tcp:8080
# then use http://127.0.0.1:8080 inside the app
```

To inspect stored settings without printing secrets:

```bash
adb shell run-as dev.remagnet.app cat shared_prefs/remagnet.settings.xml
```

The public JSON is readable; the secret value is Base64 ciphertext.

## Fonts

`app/src/main/res/font/` contains Geist Mono (regular and semibold) and
Departure Mono, converted from the extension's WOFF2 files. Both are licensed
under the SIL Open Font License; the license texts are packaged under
`app/src/main/assets/licenses/`.
