# Remagnet for Android

Early Kotlin/Jetpack Compose scaffold for the Android client. It is intentionally
small: the app renders a placeholder home screen, and the first shared domain
logic (magnet parsing) is in place with unit tests.

```
android/
  app/                     Application module (Compose)
  app/src/main/java/dev/remagnet/app/
    MainActivity.kt        Entry point and placeholder UI
    magnet/MagnetLink.kt   Magnet URI parser (mirrors the extension)
  gradle/libs.versions.toml Version catalog
```

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

## Emulator

```bash
emulator -avd remagnet-api36 -gpu host &    # windowed
# Headless / agent use:
emulator -avd remagnet-api36 -no-window -no-audio -no-boot-anim -gpu host &
adb wait-for-device
adb shell getprop sys.boot_completed   # 1 when booted
```

`-gpu host` uses the host GPU through XWayland (NVIDIA here) and boots in about
12 seconds. Software rendering is much slower, and the Android 36.1 image's
SurfaceFlinger aborts on this host, so the AVD uses the stable 36.0 image.

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

## Next steps

- Choose the client boundary: talk to qBittorrent directly, or require the
  Remagnet proxy for authenticated remote access.
- Add settings storage and a connectivity/health check.
- Build the magnet review and add flow, reusing the extension's semantics.
- Set up instrumentation tests once the first real screen exists.
