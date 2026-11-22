package dev.remagnet.app.util

import java.util.Locale
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

private val BYTE_UNITS = arrayOf("B", "KB", "MB", "GB", "TB", "PB")

/**
 * Format a byte count the way the browser clients do: one decimal below 100,
 * none at or above it, and no decimal for plain bytes.
 */
fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"

    val exponent = min(floor(ln(bytes.toDouble()) / ln(1024.0)).toInt(), BYTE_UNITS.lastIndex)
    val value = bytes / 1024.0.pow(exponent)
    val digits = when {
        exponent == 0 -> 0
        value >= 100 -> 0
        else -> 1
    }
    val rounded = String.format(Locale.ROOT, "%.${digits}f", value)
        .removeSuffix(if (digits > 0) ".0" else "")
    return "$rounded ${BYTE_UNITS[exponent]}"
}

fun formatSpeed(bytesPerSecond: Long): String = "${formatBytes(bytesPerSecond)}/s"

fun formatPercent(progress: Double): String {
    if (!progress.isFinite()) return "0%"
    return "${(min(max(progress, 0.0), 1.0) * 100).roundToInt()}%"
}
