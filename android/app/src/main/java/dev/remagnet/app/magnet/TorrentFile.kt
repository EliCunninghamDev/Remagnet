package dev.remagnet.app.magnet

import dev.remagnet.app.util.SHORT_HASH_LENGTH
import dev.remagnet.app.util.toHexString
import java.net.URI
import java.security.MessageDigest

/** Largest `.torrent` metainfo file the app will read or upload. */
const val MAX_TORRENT_FILE_BYTES: Int = 10 * 1024 * 1024

/** A `.torrent` file reduced to the details the add flow shows before uploading. */
data class TorrentFileInfo(
    val filename: String,
    val infoHash: String,
    val displayName: String?,
    val sizeBytes: Long?,
    val fileCount: Int,
    val trackers: List<String>,
    val webSeeds: List<String> = emptyList(),
    val isPrivate: Boolean = false,
)

sealed interface TorrentFileParseResult {
    data class Valid(val info: TorrentFileInfo) : TorrentFileParseResult

    data class Invalid(val message: String) : TorrentFileParseResult
}

private const val MAX_BENCODE_DEPTH = 64
private const val ERROR_EMPTY = "The .torrent file is empty."
const val ERROR_TOO_LARGE =
    "The .torrent file is too large. The maximum is 10 MiB."
private const val ERROR_NO_INFO = "The .torrent file has no info dictionary."
private const val ERROR_NO_HASH =
    "The .torrent file has neither v1 piece hashes nor BitTorrent v2 metadata."

/**
 * Parse a `.torrent` file without any dependency.
 *
 * The info hash has to be computed over the exact `info` bytes as they appear
 * in the file, so the parser records the byte span of that dictionary instead
 * of re-encoding it. This mirrors the extension's TypeScript parser.
 */
fun parseTorrentFile(bytes: ByteArray, filename: String? = null): TorrentFileParseResult {
    if (bytes.isEmpty()) return TorrentFileParseResult.Invalid(ERROR_EMPTY)
    if (bytes.size > MAX_TORRENT_FILE_BYTES) {
        return TorrentFileParseResult.Invalid(ERROR_TOO_LARGE)
    }

    val root = try {
        BencodeParser(bytes).parseRoot()
    } catch (error: TorrentFormatException) {
        return TorrentFileParseResult.Invalid(error.message ?: "The .torrent file could not be read.")
    } catch (_: Exception) {
        return TorrentFileParseResult.Invalid("The .torrent file could not be read.")
    }

    val info = root.entries["info"] as? BencodeDictionary
        ?: return TorrentFileParseResult.Invalid(ERROR_NO_INFO)
    val infoHash = infoHash(root.infoBytes, info.entries)
        ?: return TorrentFileParseResult.Invalid(ERROR_NO_HASH)
    val contents = torrentContents(info.entries)

    val fallbackName = "${infoHash.take(SHORT_HASH_LENGTH)}.torrent"
    return TorrentFileParseResult.Valid(
        TorrentFileInfo(
            filename = filename?.trim()?.takeIf { it.isNotEmpty() } ?: fallbackName,
            infoHash = infoHash,
            displayName = firstText(info.entries, listOf("name.utf-8", "name")),
            sizeBytes = contents.size,
            fileCount = contents.fileCount,
            trackers = trackersFromRoot(root.entries),
            webSeeds = webSeedsFromRoot(root.entries),
            isPrivate = integerValue(info.entries["private"]) == 1L,
        ),
    )
}

/** A readable label for a parsed torrent, falling back to a short hash. */
fun torrentFileLabel(file: TorrentFileInfo): String {
    file.displayName?.takeIf { it.isNotBlank() }?.let { return it }

    val filename = file.filename.replace(TORRENT_SUFFIX, "").trim()
    if (filename.isNotEmpty()) return filename

    return file.infoHash.take(SHORT_HASH_LENGTH)
}

/** Unique tracker hostnames, for a compact summary. */
fun trackerHosts(trackers: List<String>): List<String> {
    val hosts = LinkedHashSet<String>()
    for (tracker in trackers) {
        val host = runCatching { URI(tracker.trim()).host }.getOrNull()
        if (!host.isNullOrBlank()) hosts += host
    }
    return hosts.toList()
}

private val TORRENT_SUFFIX = Regex("\\.torrent$", RegexOption.IGNORE_CASE)

private sealed interface BencodeValue

private data class BencodeInteger(val value: Long) : BencodeValue

private class BencodeBytes(val value: ByteArray) : BencodeValue

private class BencodeList(val items: List<BencodeValue>) : BencodeValue

private class BencodeDictionary(val entries: Map<String, BencodeValue>) : BencodeValue

private class ParsedRoot(
    val entries: Map<String, BencodeValue>,
    val infoBytes: ByteArray,
)

private class TorrentFormatException(message: String) : Exception(message)

/**
 * A bencode reader with the small amount of extra bookkeeping this flow needs:
 * the raw span of the `info` value. Every malformed shape becomes a
 * [TorrentFormatException] with a message suitable for the add sheet.
 */
private class BencodeParser(private val bytes: ByteArray) {
    private var offset = 0

    fun parseRoot(): ParsedRoot {
        if (peek() != 'd'.code) {
            fail("A .torrent file must be a bencoded dictionary.")
        }
        offset += 1

        val entries = LinkedHashMap<String, BencodeValue>()
        var infoBytes: ByteArray? = null

        while (true) {
            val byte = peek()
                ?: fail("The .torrent file ends in the middle of its root dictionary.")
            if (byte == 'e'.code) {
                offset += 1
                break
            }
            if (!isDigit(byte)) {
                fail("The .torrent file has a top-level key that is not a byte string.")
            }

            val key = decodeText(parseByteString())
            val start = offset
            val value = parseValue(1)
            val end = offset

            if (key == "info") {
                if (value !is BencodeDictionary) {
                    fail("The torrent info value must be a bencoded dictionary.")
                }
                if (infoBytes != null) {
                    fail("The .torrent file contains more than one info dictionary.")
                }
                infoBytes = bytes.copyOfRange(start, end)
            }

            entries[key] = value
        }

        if (offset != bytes.size) {
            fail("The .torrent file has trailing data after the root dictionary.")
        }
        if (infoBytes == null) fail(ERROR_NO_INFO)

        return ParsedRoot(entries, infoBytes)
    }

    private fun parseValue(depth: Int): BencodeValue {
        if (depth > MAX_BENCODE_DEPTH) {
            fail("The .torrent file is nested too deeply to read.")
        }

        val byte = peek() ?: fail("The .torrent file ends unexpectedly.")
        return when {
            byte == 'i'.code -> parseInteger()
            byte == 'l'.code -> parseList(depth + 1)
            byte == 'd'.code -> parseDictionary(depth + 1)
            isDigit(byte) -> BencodeBytes(parseByteString())
            else -> fail("The .torrent file contains bencode the app cannot read.")
        }
    }

    private fun parseList(depth: Int): BencodeValue {
        offset += 1
        val items = ArrayList<BencodeValue>()

        while (true) {
            val byte = peek() ?: fail("The .torrent file ends in the middle of a list.")
            if (byte == 'e'.code) {
                offset += 1
                return BencodeList(items)
            }
            items += parseValue(depth)
        }
    }

    private fun parseDictionary(depth: Int): BencodeValue {
        offset += 1
        val entries = LinkedHashMap<String, BencodeValue>()

        while (true) {
            val byte = peek()
                ?: fail("The .torrent file ends in the middle of a dictionary.")
            if (byte == 'e'.code) {
                offset += 1
                return BencodeDictionary(entries)
            }
            if (!isDigit(byte)) {
                fail("The .torrent file has a dictionary key that is not a byte string.")
            }

            val key = decodeText(parseByteString())
            entries[key] = parseValue(depth)
        }
    }

    private fun parseInteger(): BencodeValue {
        offset += 1
        val start = offset

        if (peek() == '-'.code) offset += 1
        val digitsStart = offset
        while (isDigit(peek())) offset += 1

        if (offset == digitsStart) fail("The .torrent file has an integer without digits.")
        if (peek() != 'e'.code) fail("The .torrent file has an unterminated integer.")
        if (bytes[digitsStart] == '0'.code.toByte() && offset - digitsStart > 1) {
            fail("The .torrent file has a non-canonical integer.")
        }

        val value = decodeText(bytes.copyOfRange(start, offset)).toLongOrNull()
            ?: fail("The .torrent file has an integer outside the supported range.")
        offset += 1
        return BencodeInteger(value)
    }

    private fun parseByteString(): ByteArray {
        val start = offset
        while (isDigit(peek())) offset += 1

        if (offset == start) fail("The .torrent file has a byte string without a length.")
        if (peek() != ':'.code) {
            fail("The .torrent file has an unterminated byte string length.")
        }
        if (bytes[start] == '0'.code.toByte() && offset - start > 1) {
            fail("The .torrent file has a non-canonical byte string length.")
        }

        val length = decodeText(bytes.copyOfRange(start, offset)).toLongOrNull()
            ?: fail("The .torrent file has a byte string length outside the supported range.")
        offset += 1
        if (length < 0 || length > bytes.size - offset) {
            fail("The .torrent file has a byte string that runs past the end of the file.")
        }

        val end = offset + length.toInt()
        val value = bytes.copyOfRange(offset, end)
        offset = end
        return value
    }

    private fun peek(): Int? =
        if (offset >= bytes.size) null else bytes[offset].toInt() and 0xff

    private fun fail(message: String): Nothing = throw TorrentFormatException(message)
}

private fun infoHash(infoBytes: ByteArray, info: Map<String, BencodeValue>): String? {
    if (info["pieces"] is BencodeBytes) return digestHex("SHA-1", infoBytes)
    if (integerValue(info["meta version"]) == 2L) return digestHex("SHA-256", infoBytes)
    return null
}

private data class Contents(val size: Long?, val fileCount: Int)

private fun torrentContents(info: Map<String, BencodeValue>): Contents {
    integerValue(info["length"])?.let { return Contents(it, 1) }

    val files = info["files"]
    if (files is BencodeList) {
        var size = 0L
        for (file in files.items) {
            if (file !is BencodeDictionary) continue
            size += integerValue(file.entries["length"]) ?: 0L
        }
        return Contents(size, files.items.size)
    }

    val tree = info["file tree"]
    if (tree is BencodeDictionary) {
        val stats = fileTreeStats(tree.entries)
        return Contents(stats.size, stats.files)
    }

    return Contents(null, 0)
}

private data class FileTreeStats(val size: Long, val files: Int)

private fun fileTreeStats(tree: Map<String, BencodeValue>): FileTreeStats {
    val leaf = tree[""]
    if (leaf is BencodeDictionary) {
        return FileTreeStats(integerValue(leaf.entries["length"]) ?: 0L, 1)
    }

    var size = 0L
    var files = 0
    for (value in tree.values) {
        if (value !is BencodeDictionary) continue
        val stats = fileTreeStats(value.entries)
        size += stats.size
        files += stats.files
    }
    return FileTreeStats(size, files)
}

private fun trackersFromRoot(root: Map<String, BencodeValue>): List<String> {
    val values = ArrayList<String>()
    (root["announce"] as? BencodeBytes)?.let { values += decodeText(it.value) }
    root["announce-list"]?.let { values += flattenStrings(it) }
    return uniqueStrings(values)
}

private fun webSeedsFromRoot(root: Map<String, BencodeValue>): List<String> {
    val urlList = root["url-list"] ?: return emptyList()
    return uniqueStrings(flattenStrings(urlList))
}

/** Flatten nested bencoded string lists, which is how `announce-list` is shaped. */
private fun flattenStrings(value: BencodeValue): List<String> = when (value) {
    is BencodeBytes -> listOf(decodeText(value.value))
    is BencodeList -> value.items.flatMap(::flattenStrings)
    else -> emptyList()
}

private fun uniqueStrings(values: Iterable<String>): List<String> {
    val seen = LinkedHashSet<String>()
    for (value in values) {
        val trimmed = value.trim()
        if (trimmed.isNotEmpty()) seen.add(trimmed)
    }
    return seen.toList()
}

private fun firstText(entries: Map<String, BencodeValue>, keys: List<String>): String? {
    for (key in keys) {
        val value = entries[key]
        if (value !is BencodeBytes) continue
        val text = decodeText(value.value).trim()
        if (text.isNotEmpty()) return text
    }
    return null
}

private fun integerValue(value: BencodeValue?): Long? =
    (value as? BencodeInteger)?.value

private fun isDigit(value: Int?): Boolean =
    value != null && value >= '0'.code && value <= '9'.code

private fun decodeText(bytes: ByteArray): String = String(bytes, Charsets.UTF_8)

private fun digestHex(algorithm: String, bytes: ByteArray): String =
    MessageDigest.getInstance(algorithm).digest(bytes).toHexString()
