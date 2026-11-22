# Remagnet for Android

Kotlin/Jetpack Compose client for Android. The finished app will handle magnet
links, add them to qBittorrent with the same category and tag rules as the
browser extension, and download completed torrents as ZIPs through a Remagnet
proxy.

The build is landing in phases. [`PLAN.md`](PLAN.md) is the full plan, including
CI and release signing; this README covers what is implemented today.

## Current status

Phases 1-3 are complete:

- A connection screen for qBittorrent and the optional proxy.
- Settings that validate URLs, authentication and the proxy pair before saving.
- Encrypted credential storage using the Android Keystore.
- QR import for `remagnet://connect` links and JSON connect codes, with a paste
  fallback for devices without a camera.
- A direct qBittorrent Web API client with API-key and cookie authentication,
  torrent listing and lookup, add and remove, and category/tag creation.
- Neutral torrent models, qBittorrent state normalization and the same
  category/tag filter the extension uses.
- A proxy health check that distinguishes an unreachable proxy, a bad token and
  a proxy whose own qBittorrent connection is failing.
- A home screen that tests qBittorrent directly and reports its version without
  involving the proxy.
- Magnet intake from `VIEW magnet:` links and shared `text/plain` text, with a
  review sheet over the home screen.
- Duplicate detection, category and tag defaults, pause-on-add, and retry after
  a rejected or failed add.
- Intent and draft state kept in saved state, so a review survives rotation and
  process death.
- Bundled Geist Mono and Departure Mono, so Android matches the browser
  clients.

The torrent list, archive downloads and the foreground download notification are
Phase 4.

```
android/
  app/                     Application module (Compose)
  app/src/main/java/dev/remagnet/app/
    MainActivity.kt        Entry point and Compose host
    data/                  Settings, encrypted storage, onboarding payloads
    client/                qBittorrent client, proxy health, neutral models
    magnet/                Magnet parser, intent extraction, VIEW/SEND intake
    proxy/ProxyApi.kt      Configures the generated Retrofit client
    ui/                    Screens, add sheet, theme and shared controls
    util/Format.kt         Byte, speed and percentage formatting
  proxy-client/            Generated Kotlin/Retrofit proxy client (library)
  gradle/libs.versions.toml Version catalog
  PLAN.md                  Phased buildout, CI and signing notes
```

## Settings

The settings screen accepts:

| Setting                | Notes                                                      |
| ---------------------- | ---------------------------------------------------------- |
| qBittorrent Web UI URL | `http://` or `https://`, no credentials, query or fragment |
| Authentication         | qBittorrent 5.2+ API key, or username and password         |
| Category / tags        | Applied to magnets added from Remagnet                     |
| Proxy URL and token    | Optional; both blank disables ZIP downloads                |

The default qBittorrent URL is `http://127.0.0.1:8080`, matching the
extension. Inside the emulator, use `http://10.0.2.2:8080` to reach a service on
the host. A deployed instance normally uses an HTTPS URL.

Saving validates the whole form, writes the settings, and immediately checks
qBittorrent and the proxy when either is configured. The home screen shows the
qBittorrent version it read directly, and the proxy's view separately, so a
failure in one does not hide the other.

## qBittorrent client

`client/QBittorrentClient.kt` implements the Web API subset the app needs
against OkHttp:

| Operation     | Endpoint                                |
| ------------- | --------------------------------------- |
| Versions      | `app/version`, `app/webapiVersion`      |
| List / lookup | `torrents/info` (`sort=added_on`)       |
| Add           | `torrents/add`                          |
| Remove        | `torrents/delete`                       |
| Categories    | `torrents/categories`, `createCategory` |
| Tags          | `torrents/tags`, `createTags`           |

An API key is sent as `Authorization: Bearer <key>`. Username/password auth
posts to `auth/login`, keeps the `SID` cookie, and retries a request once after
a 401 or 403 so an expired session recovers on its own. Requests include a
same-origin `Referer`, which qBittorrent's CSRF protection expects from a
non-browser client.

Every method returns `QbitResult`: `Success` with a neutral model, or `Failure`
with a typed `QbitError` (invalid settings, unauthorized, unreachable, HTTP,
rejected torrent, unreadable response). Screens render those states directly;
there is no spinner that can hang.

Adding a torrent creates the configured category and tags first when they are
missing. The add form sends both `paused` and `stopped` so the same request
works with qBittorrent 4.x and 5.x.

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
- It asks qBittorrent for the hash before enabling **Send**. An existing torrent
  is named in the warning and blocks the add. A lookup failure still allows the
  attempt and explains that duplicates could not be checked.
- The configured category and tags are shown and applied, and **Add paused**
  sends the torrent stopped.
- A rejected or failed add keeps the magnet and its settings in the sheet, with
  the error visible. Pressing **Send** again retries the same link.
- A successful add shows the name, category and tags, with **Add another** and
  **Done** actions.
- With qBittorrent unconfigured, the link can still be reviewed; sending is
  blocked and **Open settings** goes straight to the connection form.

A pending magnet, the paused choice and an unsent paste draft live in
`SavedStateHandle`. Rotation keeps the sheet in place; process death restores the
review and re-runs the duplicate check. A request that is already sending
refuses to be swiped away or dismissed until it returns. **Add magnet** on the
home screen opens the same sheet in paste mode.

## QR onboarding

A connect code can carry either connection or both, so one scan can set up a
phone without typing secrets. The documented URI form is:

```
remagnet://connect?qbit=https%3A%2F%2Fqbt.example.com&apiKey=...&proxy=https%3A%2F%2Fremagnet.example.com&token=...
```

Recognised query keys:

| Purpose         | Keys                                                |
| --------------- | --------------------------------------------------- |
| qBittorrent URL | `qbit`, `qbitUrl`, `qbitBaseUrl`, `qbittorrent`     |
| API key         | `apiKey`, `qbitApiKey`, `key`                       |
| Username        | `username`, `qbitUsername`, `user`                  |
| Password        | `password`, `qbitPassword`, `pass`                  |
| Auth mode       | `auth`, `authMode` (`apiKey` or `password`)         |
| Category        | `category`, `defaultCategory`                       |
| Tags            | `tags`, `defaultTags`                               |
| Proxy URL       | `proxy`, `proxyUrl`, `archive`, `archiveUrl`, `url` |
| Proxy token     | `token`, `proxyToken`, `archiveToken`               |

A JSON object with the same keys is accepted. A bare `http://` or `https://` URL
is treated as the proxy URL.

Query values use URL encoding with one deliberate exception: `+` stays a plus so
Base64 tokens survive. Encode a space as `%20`, not `+`. The scanner shows the
imported values in the form and writes nothing until **Save settings** is
pressed.

The app asks for camera access the first time a code is scanned. **Paste code**
in the proxy section accepts the same payload without a camera, which is also
the path used in emulator tests.

## Security

Credentials are encrypted with an AES-256-GCM key generated inside the Android
Keystore. The key is non-exportable and is not tied to biometrics or a PIN, so
background health checks work without an unlock prompt.

Public values (URLs, auth mode, username, category, tags) stay readable in
SharedPreferences so the settings screen can render without decrypting
anything. The API key, password and proxy token are stored only as ciphertext in
one encrypted JSON value.

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
ciphertext recovery, QR parsing, settings merging, proxy error mapping,
qBittorrent state and filter rules, and the qBittorrent client against an
in-process HTTP server. That server exercises API-key and cookie auth,
re-login after an expired session, list and lookup, category/tag creation, add,
remove, rejected magnets and malformed responses. Magnet tests cover hex and
base32 hashes, web seeds, wrapped shared text, `VIEW` and `SEND` intake,
duplicate-state mapping, add-request defaults and byte formatting. They run on
the JVM and do not need an emulator.

## CI

`.github/workflows/android.yml` runs the unit tests and lint, builds a debug APK
and uploads it as an artifact on changes under `android/`, `packages/proxy-client/`
or the proxy contract. Debug builds are signed with the runner's generated debug
key, so they install without repository secrets.

Release signing needs a keystore kept outside the repository. `PLAN.md` covers
key generation, the Gradle wiring and the environment variables the release
workflow will use. `*.jks`, `*.keystore` and `keystore.properties` are ignored.

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
