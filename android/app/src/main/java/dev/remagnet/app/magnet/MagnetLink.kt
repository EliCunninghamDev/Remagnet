package dev.remagnet.app.magnet

import java.net.URLDecoder

/**
 * The parts of a magnet URI that are useful before a client resolves metadata.
 *
 * Android groundwork: this mirrors the extension's TypeScript parser so both
 * clients agree on hashes, display names, sizes and trackers.
 */
data class MagnetLink(
    val uri: String,
    val infoHash: String?,
    val displayName: String?,
    val sizeBytes: Long?,
    val trackers: List<String>,
)

private val HEX_HASH = Regex("^[0-9a-f]{40}$", RegexOption.IGNORE_CASE)

/** Parse a BitTorrent v1 magnet, or return null when the URI is not a magnet. */
fun parseMagnet(uri: String): MagnetLink? {
    val trimmed = uri.trim()
    if (!trimmed.startsWith("magnet:?", ignoreCase = true)) return null

    val params = trimmed
        .substringAfter('?', "")
        .split('&')
        .filter { it.isNotEmpty() }
        .mapNotNull { part ->
            val separator = part.indexOf('=')
            if (separator <= 0) {
                null
            } else {
                decode(part.substring(0, separator)) to decode(part.substring(separator + 1))
            }
        }

    val infoHash = params
        .asSequence()
        .filter { (key, _) -> key == "xt" }
        .map { (_, value) -> value }
        .mapNotNull { value ->
            value.takeIf { it.startsWith("urn:btih:", ignoreCase = true) }
                ?.substring("urn:btih:".length)
        }
        .firstOrNull { HEX_HASH.matches(it) }
        ?.lowercase()

    return MagnetLink(
        uri = trimmed,
        infoHash = infoHash,
        displayName = params.firstOrNull { (key, _) -> key == "dn" }?.second?.takeIf { it.isNotBlank() },
        sizeBytes = params.firstOrNull { (key, _) -> key == "xl" }?.second?.toLongOrNull(),
        trackers = params.filter { (key, _) -> key == "tr" }.map { (_, value) -> value },
    )
}

/** Magnet query strings percent-encode values; `+` is literal, not a space. */
private fun decode(value: String): String =
    runCatching {
        // The String overload is the one available on API 26; the Charset
        // overload arrived in API 33.
        URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
    }.getOrDefault(value)
