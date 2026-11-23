package dev.remagnet.app.client

import android.os.Build

/**
 * A best-effort label for this phone in the proxy's device list.
 *
 * Unit tests run against the JVM stub of `android.os.Build`, where the fields
 * are null rather than populated. Reading them defensively keeps the default
 * safe on both a real device and a plain JVM test, and the proxy caps names at
 * 64 characters.
 */
internal fun androidDeviceName(): String {
    val model = runCatching { Build.MODEL }.getOrNull()?.trim().orEmpty()
    val manufacturer = runCatching { Build.MANUFACTURER }.getOrNull()?.trim().orEmpty()

    val name = when {
        model.isBlank() -> ""
        manufacturer.isBlank() -> model
        model.startsWith(manufacturer, ignoreCase = true) -> model
        else -> "$manufacturer $model"
    }

    return name.take(64).ifBlank { "Android" }
}
