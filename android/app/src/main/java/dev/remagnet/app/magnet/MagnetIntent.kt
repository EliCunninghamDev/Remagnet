package dev.remagnet.app.magnet

import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * Read a magnet or `.torrent` file out of an incoming intent.
 *
 * `dataString` covers `VIEW magnet:` and `VIEW content://…torrent`;
 * `EXTRA_STREAM` covers `SEND` from browsers, chat apps and file managers.
 * Some apps put files in a list or only populate `clipData`, so both shapes
 * are flattened before parsing.
 */
fun magnetIntakeFromIntent(intent: Intent?): MagnetIntake {
    if (intent == null) return MagnetIntake.None
    return extractMagnetIntake(
        action = intent.action,
        data = intent.dataString,
        text = intentText(intent),
        streamUri = intentStreamUri(intent),
        mimeType = intent.type,
    )
}

private fun intentText(intent: Intent): String? {
    intent.getStringExtra(Intent.EXTRA_TEXT)?.let { return it }
    intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { return it.toString() }
    return intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
        ?.joinToString("\n") { it.toString() }
}

private fun intentStreamUri(intent: Intent): String? {
    val single: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }
    single?.let { return it.toString() }

    val multiple: List<Uri>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
    }
    multiple?.firstOrNull()?.let { return it.toString() }

    val clip = intent.clipData ?: return null
    for (index in 0 until clip.itemCount) {
        clip.getItemAt(index)?.uri?.let { return it.toString() }
    }
    return null
}
