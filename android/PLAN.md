# Android buildout

This document is the working plan for the Kotlin client. It describes the
target architecture and the order the pieces land in. Each phase is meant to
end with something usable, tested and shippable; later phases build on it
without leaving throwaway scaffolding behind.

| Phase                                           | Status      |
| ----------------------------------------------- | ----------- |
| 1. Settings, secure storage, onboarding, health | Implemented |
| 2. qBittorrent client                           | Implemented |
| 3. Magnet intake and review                     | Implemented |
| 4. Torrent list and archive downloads           | Implemented |
| 5. Polish and release                           | Planned     |

## Product surface

Remagnet for Android is a system-wide magnet handler and a small companion to
the same torrent client the browser extension uses.

- A magnet link opened from a browser, chat app or file manager opens
  Remagnet with the link already reviewed in a bottom sheet over the torrent
  list. The list stays visible; adding does not replace the screen.
- Adding sends the magnet to qBittorrent with the configured category and tags.
- The home screen lists the torrents that belong to Remagnet, shows live
  progress in the same square-cell bar as the extension, and can remove a
  torrent with a keep-files or delete-files choice.
- Completed torrents can be downloaded as a ZIP through a deployed Remagnet
  proxy. The proxy is optional; without it, the app still adds and manages
  torrents.
- Onboarding can be a QR code that carries the qBittorrent and proxy
  connection details, so nothing has to be typed on a phone keyboard.

The extension remains the primary client. Android shares its domain rules
(magnet parsing, state labels, formatting, status colours) rather than
inventing a second interpretation of them.

## Architecture

```
app/
  MainActivity              single activity, intent intake, Compose host
  data/
    RemagnetSettings        plain settings model + validation
    SettingsRepository      merging, defaults, validation, persistence
    KeyValueStore           small storage seam for tests
    SecretCipher            encrypt/decrypt seam
    KeystoreSecretCipher    Android Keystore AES-256-GCM
  client/
    QBittorrentClient       qBittorrent Web API v2 (OkHttp + Gson)
    ProxyClient             generated Retrofit client + error mapping
    TorrentModels           neutral models shared by the UI
  ui/
    RemagnetApp             navigation and intent routing
    home/                   torrent list, status, empty and error states
    add/                    magnet review and add result
    settings/               connection settings and validation
    onboarding/             QR scanner and payload import
    components/             wordmark, tile bar, torrent row, controls
    theme/                  tokens, colour scheme, bundled type
  magnet/                   magnet URI parser (already present)
  util/                     formatting shared with the extension's semantics
```

Rules:

- The UI never talks to OkHttp, Retrofit, SharedPreferences or the Keystore
  directly. It calls a repository or ViewModel and renders state.
- Credentials live only in encrypted form on disk. Public settings stay
  readable so the app can render the configuration screen without unlocking
  anything.
- A network call returns a typed result. Screens render loading, success,
  empty and error states explicitly; no spinner that can hang forever.
- Client-neutral models keep a future second torrent client from leaking into
  the UI.

## Security

- Android Keystore holds a non-exportable AES-256-GCM key. Ciphertext and IV
  are the only secret material in SharedPreferences.
- The key is not tied to biometrics or a PIN, so background polling and QR
  imports work without an unlock prompt.
- A cleared Keystore or restored backup leaves orphaned ciphertext. It is
  treated as "no saved secret" and the settings screen asks for it again.
- QR payloads contain credentials. The scanner only accepts the documented
  `remagnet://connect` scheme and JSON object, shows what it will import, and
  does not write anything until the user confirms.
- Release builds allow cleartext only for the emulator host and loopback, as
  the existing network security config does.

## CI and signing

Android was the first component to get CI because it cannot be checked by
`bun run check` alone. The debug workflow and unified release workflow are in
place; adding the signing secrets switches releases from debug to signed.

### What "unsigned APK" means

Every APK Android installs must be signed, including debug builds. The Android
Gradle plugin signs debug builds with an automatically generated
`~/.android/debug.keystore`; CI creates one on first use. A release build
without a configured signing key produces `app-release-unsigned.apk`, which is
useful as a build artifact but cannot be installed.

That gives two sensible CI outputs:

1. A debug APK on every relevant push or pull request. It is installable, needs
   no repository secrets, and is enough for manual testing.
2. A signed release APK on a version tag. It needs a keystore kept outside the
   repository.

Building an unsigned release APK as the primary artifact is not useful for
testers. Releases therefore attach a debug-signed APK until the signing secrets
exist, then switch to a signed release APK and AAB automatically.

### Release key

Generate the key once on a trusted machine and keep two backups (a password
manager and offline storage):

```bash
keytool -genkeypair -v \
  -keystore remagnet-release.jks \
  -alias remagnet \
  -keyalg RSA -keysize 4096 -validity 10000
```

The certificate is valid for about 27 years, which is longer than the app is
likely to need; Google Play additionally requires an expiry after 2033. Losing
this key means an installed copy cannot be upgraded in place. If the app is
published through Google Play, use Play App Signing instead: Google holds the
app signing key and this keystore becomes a rotatable upload key.

The keystore, its passwords and the generated `keystore.properties` stay out of
git. `android/.gitignore` should list `*.jks`, `*.keystore` and
`keystore.properties` before the first release build.

### Gradle wiring

`app/build.gradle.kts` reads signing values from environment variables and
creates the release signing config only when all of them are present:

```kotlin
val storePath = System.getenv("REMAGNET_KEYSTORE")
val storePassword = System.getenv("REMAGNET_KEYSTORE_PASSWORD")
val keyAlias = System.getenv("REMAGNET_KEY_ALIAS")
val keyPassword = System.getenv("REMAGNET_KEY_PASSWORD")
val hasReleaseKey = listOf(storePath, storePassword, keyAlias, keyPassword)
    .all { !it.isNullOrBlank() }

android {
    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(storePath!!)
                this.storePassword = storePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }
}
```

With no variables set, `assembleRelease` keeps producing an unsigned APK and
the debug workflow is unaffected. CI decodes the base64 keystore to
`$RUNNER_TEMP` and passes its path; it never writes the key into the checkout.

### Workflows

`.github/workflows/android.yml` (implemented):

- Trigger on `push` and `pull_request` paths `android/**`,
  `packages/proxy-client/**`, `proxy/openapi.yaml` and the workflow file, plus
  `workflow_dispatch`.
- `actions/checkout`, `actions/setup-java` with Temurin 21,
  `gradle/actions/setup-gradle` for caching.
- Install the platform and build tools, then run
  `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`.
- Upload the debug APK with `actions/upload-artifact` and a short retention.
- Run on `ubuntu-latest`.

`.github/workflows/release.yml` (implemented):

- Trigger on `vMAJOR.MINOR.PATCH` tags and validate the tag against every
  component version.
- Set `versionCode` from the run number and `versionName` from the tag.
- When the signing secrets exist, decode `ANDROID_KEYSTORE_BASE64` into
  `$RUNNER_TEMP/remagnet-release.jks`, build the signed release APK and AAB,
  and verify the APK with `apksigner verify --print-certs`.
- Without the secrets, build and attach a debug-signed APK instead.
- Attach the Android packages, extension packages, and a combined
  `SHA256SUMS` file to the GitHub Release.

Repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The base64 form is
`base64 -w0 remagnet-release.jks` on Linux or
`base64 -i remagnet-release.jks` on macOS.

### Acceptance

- A pull request that changes Android code runs unit tests, lint and a debug
  build, and exposes the APK as a downloadable artifact.
- A tag builds a release APK signed with the release key, verifies the
  certificate and publishes it. Without the secrets it publishes a debug APK.
- A fork without secrets still passes the debug workflow.
- No keystore, password or APK is ever committed.

## Phases

### Phase 1 - foundation: settings, secure storage, onboarding, health

Deliverables:

- Settings model and validation for qBittorrent and proxy connections.
- Encrypted secret storage using Android Keystore; public values in
  SharedPreferences.
- QR payload parser and scanner; paste-in fallback for devices without a
  camera.
- Proxy health check through the generated client with readable errors.
- Compose shell with the Remagnet wordmark, home status screen and a settings
  screen that saves, validates and tests.
- Unit tests for validation, storage round-trips, QR parsing and health error
  mapping.
- The debug Android CI workflow (tests, lint, installable debug APK artifact),
  with release signing left for Phase 5.
- Emulator smoke test: install, configure against a local mock, test the
  connection, relaunch and confirm the settings survive.

Acceptance: the app opens to a real status screen, can be configured by hand
or QR, reports whether the proxy and its qBittorrent connection are healthy,
and never writes a token or API key in plaintext.

### Phase 2 - qBittorrent client

Deliverables:

- OkHttp implementation of the Web API subset the app needs: connection
  test, torrent list, single-torrent lookup, add, remove, categories and tags.
- API-key authentication and cookie-based username/password authentication,
  matching the extension's behavior.
- Neutral torrent models, state normalization and the shared filter rules.
- Repository-level tests against an in-process HTTP server, including auth
  failures, rejected magnets and removal.

Acceptance: the app can list, add and remove torrents against a real
qBittorrent instance without the proxy.

### Phase 3 - magnet intake and review

Deliverables:

- `VIEW` intent filter for `magnet:` links and `SEND` text intake.
- Add flow as a Material 3 modal bottom sheet over the home list, not a
  separate activity or a full-screen replacement. The sheet can be dragged,
  dismissed with back, and reopened from the **Add** action.
- Review content with name, hash, size and tracker summary.
- Duplicate detection before add, category/tag application, pause-on-add.
- Success and failure states inside the sheet that keep the magnet available
  for retry; a failed add never discards the link.
- Intent state survives activity recreation (rotation, process death) through
  saved state rather than a static singleton.
- Tests for intent extraction, duplicate handling and add errors.

Acceptance: tapping a magnet link anywhere on the device opens Remagnet with
the add sheet over the list, and one confirmation adds it to the configured
client without hiding the home screen.

### Phase 4 - torrent list and archive downloads

Deliverables:

- Home list with the shared tile bar, percentage counter, state colors and
  live stats.
- Foreground polling while the screen is visible; no polling in the
  background.
- Removal confirmation with keep-files and delete-files choices.
- ZIP downloads through the proxy in a foreground service rather than
  `DownloadManager`, so the token stays in a header and progress can be
  rendered the way the product wants.
- A progress notification with live bytes transferred and speed. The proxy
  streams ZIPs without `Content-Length`, so the service shows indeterminate
  progress unless the caller supplied the torrent size; with a size it shows a
  smoothed determinate bar. The system animates each progress update, and the
  in-app row uses the same tile counter as the browser extension.
- Notification actions for cancel and retry, a completion notification that
  opens the saved file, and a failure notification that keeps the error text.
- One archive download at a time, with a clear message instead of a silent
  queue.
- Runtime `POST_NOTIFICATIONS` request on Android 13+, and a `dataSync`
  foreground service declaration for Android 14+.
- Empty, loading, unreachable and filtered-list states.

Acceptance: a completed torrent can be downloaded as a ZIP from the phone,
the notification tracks it while the app is in the background, and a partial
torrent cannot.

Implemented as:

- `ArchiveDownloadService` streams through OkHttp with a bearer header and
  `OkHttpClient` timeouts disabled for the read phase, because the proxy builds
  the ZIP while it sends it.
- Progress uses the torrent size as the denominator and an exponentially
  weighted speed meter. Notifications update at most four times a second.
- A single in-memory coordinator reserves one hash. The state survives a
  service restart, so a notification Retry works even after the activity is
  gone.
- Archives go to the app-specific external Downloads folder with a sanitized,
  unique `.zip` name and a `.part` file during transfer. A cancelled or failed
  transfer deletes the partial file.
- Completion and in-app **Open** launch `OpenArchiveActivity`, which uses a
  `FileProvider` URI and falls back to a share sheet.
- The row and notification share testable pieces: `TileBar` geometry and
  counter, `ArchiveFiles` naming and disposition parsing, `SpeedMeter`, and
  `ArchiveDownloads` state transitions.

Emulator smoke tests covered the filtered four-item list, five-second polling,
the notification permission prompt, a background download, in-app and
notification cancel, proxy-down failure and notification retry, the
already-downloading message, keep-files removal, rotation during a download,
completion with unique `(2)`/`(3)`/`(4)` names, and the share-sheet fallback
for **Open** on an image without a ZIP viewer.

### Phase 5 - polish and release

Deliverables:

- Bundled Departure Mono and Geist Mono, matching the browser clients.
- Accessibility labels, large-font layout, landscape and rotation checks.
- Compose UI tests for the main flows.
- Release signing notes, versioning, ProGuard keep rules for Gson models.
- Updated Android README with the QR payload format and screenshots.
- Full emulator pass on a clean install.

Acceptance: clean install to first successful download without reading
source, plus a passing lint, unit and UI test run.

## Testing strategy

| Layer       | Tool                        | What it covers                                                       |
| ----------- | --------------------------- | -------------------------------------------------------------------- |
| Pure Kotlin | JUnit 4                     | validation, formatting, QR parsing, state mapping, intent extraction |
| Repository  | JUnit 4 + fake store/cipher | defaults, round-trips, corrupt ciphertext                            |
| HTTP        | JUnit 4 + JDK HttpServer    | qBittorrent auth, add/remove, error mapping                          |
| Compose     | Compose UI test             | settings validation, save, connection status                         |
| Device      | emulator + adb              | install, intent intake, QR import, download                          |

The emulator runs inside the agent's private desktop session, never the host
display. Mock services bind to the host and are reached from the emulator at
`10.0.2.2`.
