package dev.remagnet.app.magnet

import dev.remagnet.app.util.SHORT_HASH_LENGTH
import dev.remagnet.app.util.toHexString
import java.net.URLDecoder
import java.util.Locale

/**
 * The parts of a magnet URI that are useful before a client resolves metadata.
 *
 * This mirrors the extension's TypeScript parser so both clients agree on
 * hashes, display names, sizes, trackers and web seeds.
 */
data class MagnetLink(
    val uri: String,
    val infoHash: String?,
    val displayName: String?,
    val sizeBytes: Long?,
    val trackers: List<String>,
    val webSeeds: List<String> = emptyList(),
)

private const val BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
private val HEX_HASH = Regex("^[0-9a-f]{40}$", RegexOption.IGNORE_CASE)
private val BASE32_HASH = Regex("^[a-z2-7]{32}$", RegexOption.IGNORE_CASE)
private val DIGITS = Regex("^\\d+$")
private val MAGNET_SCHEME = Regex("^magnet:\\?", RegexOption.IGNORE_CASE)
private val WRAPPING_START = Regex("^[<(\"'\\[]+")
private val WRAPPING_END = Regex("[>)\"'\\].,;]+$")

/** Parse a BitTorrent v1 magnet, or return null when the URI is not a magnet. */
fun parseMagnet(uri: String): MagnetLink? {
    val trimmed = uri.trim()
    if (!MAGNET_SCHEME.containsMatchIn(trimmed)) return null

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
        .mapNotNull(::parseBitTorrentHash)
        .firstOrNull()

    return MagnetLink(
        uri = trimmed,
        infoHash = infoHash,
        displayName = params.firstOrNull { (key, _) -> key == "dn" }
            ?.second
            ?.trim()
            ?.takeIf { it.isNotEmpty() },
        sizeBytes = params.firstOrNull { (key, _) -> key == "xl" }
            ?.second
            ?.takeIf { DIGITS.matches(it) }
            ?.toLongOrNull(),
        trackers = params
            .filter { (key, _) -> key == "tr" }
            .map { (_, value) -> value.trim() }
            .filter { it.isNotEmpty() },
        webSeeds = params
            .filter { (key, _) -> key == "ws" }
            .map { (_, value) -> value.trim() }
            .filter { it.isNotEmpty() },
    )
}

/** True when a value claims to be a magnet URI, even if its hash is unusable. */
fun isMagnetLink(value: String): Boolean = MAGNET_SCHEME.containsMatchIn(value.trim())

/**
 * Pick a magnet URI out of a link or surrounding text.
 *
 * Shared text often wraps the URI in quotes, brackets or trailing punctuation.
 */
fun magnetFromText(value: String?): String? {
    if (value.isNullOrBlank()) return null

    for (token in value.trim().split(Regex("\\s+"))) {
        val candidate = token
            .replace(WRAPPING_START, "")
            .replace(WRAPPING_END, "")
        if (parseMagnet(candidate) != null) return candidate
    }

    return null
}

/** A readable label for a parsed magnet, falling back to a short hash. */
fun magnetLabel(magnet: MagnetLink): String {
    magnet.displayName?.let { return it }
    magnet.infoHash?.let { return it.take(SHORT_HASH_LENGTH) }
    return "Magnet link"
}

/** Unique tracker hostnames, for a compact summary. */
fun trackerHosts(magnet: MagnetLink): List<String> = trackerHosts(magnet.trackers)

private fun parseBitTorrentHash(value: String): String? {
    val trimmed = value.trim()
    if (!trimmed.startsWith("urn:btih:", ignoreCase = true)) return null

    val hash = trimmed.substring("urn:btih:".length)
    return when {
        HEX_HASH.matches(hash) -> hash.lowercase(Locale.ROOT)
        BASE32_HASH.matches(hash) -> base32ToHex(hash)
        else -> null
    }
}

/** Decode an RFC 4648 base32 info hash (without padding) to lowercase hex. */
private fun base32ToHex(value: String): String? {
    val clean = value.uppercase(Locale.ROOT).trimEnd('=')
    val bytes = ArrayList<Byte>(20)
    var bits = 0
    var buffer = 0

    for (character in clean) {
        val index = BASE32_ALPHABET.indexOf(character)
        if (index == -1) return null

        buffer = (buffer shl 5) or index
        bits += 5
        if (bits >= 8) {
            bytes += ((buffer ushr (bits - 8)) and 0xff).toByte()
            bits -= 8
        }
    }

    if (bytes.size != 20) return null
    return bytes.toByteArray().toHexString()
}

/**
 * Magnet query strings use form encoding: `+` is a space and `%20` also works.
 * Decoding failures keep the raw value rather than discarding the parameter.
 */
private fun decode(value: String): String =
    runCatching {
        // The String overload is the one available on API 26; the Charset
        // overload arrived in API 33.
        URLDecoder.decode(value, "UTF-8")
    }.getOrDefault(value)
