package dev.remagnet.app.magnet

import android.content.Intent

/**
 * Read a magnet out of an incoming intent.
 *
 * `dataString` covers `VIEW magnet:`; shared text covers `SEND` from browsers,
 * chat apps and file managers. Some apps put the magnet in a list for
 * `SEND_MULTIPLE`, so the text extra is flattened before parsing.
 */
fun magnetIntakeFromIntent(intent: Intent?): MagnetIntake {
    if (intent == null) return MagnetIntake.None
    return extractMagnetIntake(
        action = intent.action,
        data = intent.dataString,
        text = intentText(intent),
    )
}

private fun intentText(intent: Intent): String? {
    intent.getStringExtra(Intent.EXTRA_TEXT)?.let { return it }
    intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { return it.toString() }
    return intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
        ?.joinToString("\n") { it.toString() }
}
