package dev.remagnet.app.magnet

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TorrentFileTest {
    @Test
    fun parsesASingleFileV1Torrent() {
        val info = linkedMapOf<String, Any?>(
            "length" to 4096,
            "name" to "Ubuntu desktop",
            "piece length" to 16384,
            "pieces" to ByteArray(20) { 0xab.toByte() },
        )
        val bytes = bencode(
            linkedMapOf(
                "announce" to "udp://tracker.example:1337/announce",
                "url-list" to "https://seed.example/ubuntu.iso",
                "info" to info,
            ),
        )

        val result = parseTorrentFile(bytes, "ubuntu.torrent")

        assertTrue(result.toString(), result is TorrentFileParseResult.Valid)
        val parsed = (result as TorrentFileParseResult.Valid).info
        assertEquals("ubuntu.torrent", parsed.filename)
        assertEquals(digestHex("SHA-1", bencode(info)), parsed.infoHash)
        assertEquals(40, parsed.infoHash.length)
        assertEquals("Ubuntu desktop", parsed.displayName)
        assertEquals(4096L, parsed.sizeBytes)
        assertEquals(1, parsed.fileCount)
        assertEquals(listOf("udp://tracker.example:1337/announce"), parsed.trackers)
        assertEquals(listOf("https://seed.example/ubuntu.iso"), parsed.webSeeds)
        assertEquals(false, parsed.isPrivate)
    }

    @Test
    fun parsesAMultiFileV1TorrentWithAnnounceListAndPrivateFlag() {
        val info = linkedMapOf<String, Any?>(
            "files" to listOf(
                linkedMapOf("length" to 1024, "path" to listOf("part-one.bin")),
                linkedMapOf("length" to 2048, "path" to listOf("part-two.bin")),
            ),
            "name" to "Multi",
            "private" to 1,
            "piece length" to 16384,
            "pieces" to ByteArray(20) { 0x11.toByte() },
        )
        val bytes = bencode(
            linkedMapOf(
                "announce" to "udp://tracker.example/announce",
                "announce-list" to listOf(
                    listOf(
                        "udp://tracker.example/announce",
                        "https://backup.example/announce",
                    ),
                    listOf("udp://other.example/announce"),
                ),
                "info" to info,
            ),
        )

        val parsed = validInfo(parseTorrentFile(bytes, "multi.torrent"))

        assertEquals(digestHex("SHA-1", bencode(info)), parsed.infoHash)
        assertEquals("Multi", parsed.displayName)
        assertEquals(3072L, parsed.sizeBytes)
        assertEquals(2, parsed.fileCount)
        assertEquals(
            listOf(
                "udp://tracker.example/announce",
                "https://backup.example/announce",
                "udp://other.example/announce",
            ),
            parsed.trackers,
        )
        assertTrue(parsed.isPrivate)
    }

    @Test
    fun parsesAV2OnlyTorrentWithASha256InfoHash() {
        val info = linkedMapOf<String, Any?>(
            "file tree" to linkedMapOf(
                "disc-one" to linkedMapOf("" to linkedMapOf("length" to 1024)),
                "disc-two" to linkedMapOf(
                    "nested" to linkedMapOf("" to linkedMapOf("length" to 2048)),
                ),
            ),
            "meta version" to 2,
            "name" to "v2-only",
            "piece length" to 16384,
        )
        val bytes = bencode(linkedMapOf("info" to info))

        val parsed = validInfo(parseTorrentFile(bytes, "v2.torrent"))

        assertEquals(digestHex("SHA-256", bencode(info)), parsed.infoHash)
        assertEquals(64, parsed.infoHash.length)
        assertEquals("v2-only", parsed.displayName)
        assertEquals(3072L, parsed.sizeBytes)
        assertEquals(2, parsed.fileCount)
    }

    @Test
    fun usesTheV1Sha1HashForHybridTorrents() {
        val info = linkedMapOf<String, Any?>(
            "files" to listOf(linkedMapOf("length" to 4096, "path" to listOf("hybrid.bin"))),
            "file tree" to linkedMapOf(
                "hybrid.bin" to linkedMapOf("" to linkedMapOf("length" to 4096)),
            ),
            "meta version" to 2,
            "name" to "Hybrid",
            "piece length" to 16384,
            "pieces" to ByteArray(20) { 0x22.toByte() },
        )
        val bytes = bencode(linkedMapOf("info" to info))

        val parsed = validInfo(parseTorrentFile(bytes))

        assertEquals(digestHex("SHA-1", bencode(info)), parsed.infoHash)
        assertEquals(40, parsed.infoHash.length)
        assertEquals(4096L, parsed.sizeBytes)
        assertEquals(1, parsed.fileCount)
    }

    @Test
    fun rejectsEmptyAndOversizedFiles() {
        assertInvalid(parseTorrentFile(ByteArray(0)), "empty")

        val oversized = ByteArray(MAX_TORRENT_FILE_BYTES + 1)
        assertInvalid(parseTorrentFile(oversized), "too large")
    }

    @Test
    fun rejectsMalformedBencode() {
        assertInvalid(parseTorrentFile("not bencode".toByteArray()), "bencoded dictionary")
        assertInvalid(parseTorrentFile("d3:fooi1e".toByteArray()), "middle")
        assertInvalid(parseTorrentFile("d3:foo!".toByteArray()), "cannot read")
    }

    @Test
    fun rejectsTrailingBytesAfterTheRootDictionary() {
        val bytes = bencode(
            linkedMapOf(
                "info" to linkedMapOf(
                    "length" to 1,
                    "name" to "Tiny",
                    "pieces" to ByteArray(20),
                ),
            ),
        )

        assertInvalid(parseTorrentFile(bytes + "x".toByteArray()), "trailing")
    }

    @Test
    fun rejectsATorrentWithoutAnInfoDictionary() {
        assertInvalid(
            parseTorrentFile(bencode(linkedMapOf("announce" to "udp://tracker.example"))),
            "no info",
        )
    }

    @Test
    fun fallsBackToTheShortHashForABlankFilename() {
        val bytes = tinyTorrent()
        val parsed = validInfo(parseTorrentFile(bytes, "  "))

        assertEquals("${parsed.infoHash.take(12)}.torrent", parsed.filename)
        assertNull(parsed.sizeBytes)
        assertEquals(0, parsed.fileCount)
    }

    @Test
    fun labelsTorrentsByDisplayNameThenFilenameThenShortHash() {
        val base = TorrentFileInfo(
            filename = "Example.torrent",
            infoHash = "abcdef1234567890",
            displayName = null,
            sizeBytes = null,
            fileCount = 0,
            trackers = emptyList(),
        )

        assertEquals("Name", torrentFileLabel(base.copy(displayName = "Name")))
        assertEquals("Example", torrentFileLabel(base))
        assertEquals("abcdef123456", torrentFileLabel(base.copy(filename = "")))
    }

    @Test
    fun reducesTrackersToUniqueValidHosts() {
        assertEquals(
            listOf("a.example"),
            trackerHosts(
                listOf(
                    "https://a.example/announce",
                    "https://a.example/other",
                    "not-a-url",
                ),
            ),
        )
    }

    private fun tinyTorrent(): ByteArray = bencode(
        linkedMapOf(
            "info" to linkedMapOf(
                "name" to "Tiny",
                "pieces" to ByteArray(20),
            ),
        ),
    )

    private fun validInfo(result: TorrentFileParseResult): TorrentFileInfo {
        assertTrue(result.toString(), result is TorrentFileParseResult.Valid)
        return (result as TorrentFileParseResult.Valid).info
    }

    private fun assertInvalid(result: TorrentFileParseResult, messagePart: String) {
        assertTrue(result.toString(), result is TorrentFileParseResult.Invalid)
        val message = (result as TorrentFileParseResult.Invalid).message
        assertTrue(
            "Expected \"$message\" to contain \"$messagePart\"",
            message.contains(messagePart, ignoreCase = true),
        )
    }
}

private fun bencode(value: Any?): ByteArray = when (value) {
    is String -> byteString(value.toByteArray(Charsets.UTF_8))
    is Int -> "i${value}e".toByteArray()
    is Long -> "i${value}e".toByteArray()
    is ByteArray -> byteString(value)
    is List<*> -> concat(
        listOf("l".toByteArray()) +
            value.map(::bencode) +
            listOf("e".toByteArray()),
    )

    is Map<*, *> -> {
        val parts = ArrayList<ByteArray>()
        parts += "d".toByteArray()
        for ((key, entryValue) in value.entries.sortedBy { it.key.toString() }) {
            parts += byteString(key.toString().toByteArray(Charsets.UTF_8))
            parts += bencode(entryValue)
        }
        parts += "e".toByteArray()
        concat(parts)
    }

    else -> error("Cannot bencode $value")
}

private fun byteString(bytes: ByteArray): ByteArray =
    concat(listOf("${bytes.size}:".toByteArray(), bytes))

private fun concat(parts: List<ByteArray>): ByteArray {
    val result = ByteArray(parts.sumOf { it.size })
    var offset = 0
    for (part in parts) {
        part.copyInto(result, offset)
        offset += part.size
    }
    return result
}

private fun digestHex(algorithm: String, bytes: ByteArray): String {
    val digest = MessageDigest.getInstance(algorithm).digest(bytes)
    return digest.joinToString("") { byte ->
        (byte.toInt() and 0xff).toString(16).padStart(2, '0')
    }
}
