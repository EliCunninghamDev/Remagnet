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

/** qBittorrent's unknown/unlimited ETA. */
const val ETA_UNKNOWN_SECONDS = 8_640_000L

/** A compact remaining-time label; unknown values become an em dash. */
fun formatEta(seconds: Long): String {
    if (seconds <= 0 || seconds >= ETA_UNKNOWN_SECONDS) return "—"
    if (seconds < 60) return "${seconds}s"

    val minutes = seconds / 60
    if (minutes < 60) return "${minutes}m"

    val hours = minutes / 60
    if (hours < 24) return "${hours}h ${minutes % 60}m"

    return "${hours / 24}d ${hours % 24}h"
}

/** The first and last parts of a long name, with the middle left to clipping. */
data class NameSplit(val head: String, val tail: String)

private const val NAME_FIT = 28
private const val NAME_TAIL = 16
private const val NAME_BOUNDARY = 5

/**
 * Split a long torrent name so the file extension stays visible on a narrow
 * row. Short names come back whole. The two parts together are always the
 * original name, so a tooltip or accessibility label stays complete.
 */
fun splitTorrentName(name: String): NameSplit {
    val points = name.codePoints().toArray()
    if (points.size <= NAME_FIT) return NameSplit(name, "")

    var start = points.size - NAME_TAIL
    for (index in start downTo max(1, start - NAME_BOUNDARY + 1)) {
        if (isNameSeparator(points[index - 1])) {
            start = index
            break
        }
    }

    return NameSplit(
        head = codePointsToString(points, 0, start),
        tail = codePointsToString(points, start, points.size - start),
    )
}

private fun isNameSeparator(codePoint: Int): Boolean =
    codePoint == ' '.code ||
        codePoint == '\t'.code ||
        codePoint == '\n'.code ||
        codePoint == '.'.code ||
        codePoint == '_'.code ||
        codePoint == '-'.code

private fun codePointsToString(points: IntArray, start: Int, count: Int): String {
    val builder = StringBuilder(count)
    for (index in start until start + count) builder.appendCodePoint(points[index])
    return builder.toString()
}
