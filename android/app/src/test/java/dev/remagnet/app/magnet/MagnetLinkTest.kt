package dev.remagnet.app.magnet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MagnetLinkTest {
    private val hex = "d540fc48eb12f2833163eed6421d449dd8f1ce1f"
    private val base32 = "2VAPYSHLCLZIGMLD53LEEHKETXMPDTQ7"

    @Test
    fun parsesMagnetMetadata() {
        val link = parseMagnet(
            "magnet:?xt=urn:btih:9F2C1E7A4B8D0F63C5A91E2D7B4F8A06C3E1D5B7" +
                "&dn=nebula-4.2-amd64-netinst.iso&xl=1087795200" +
                "&tr=http%3A%2F%2Ftracker.example%3A6969%2Fannounce",
        )

        assertEquals("9f2c1e7a4b8d0f63c5a91e2d7b4f8a06c3e1d5b7", link?.infoHash)
        assertEquals("nebula-4.2-amd64-netinst.iso", link?.displayName)
        assertEquals(1_087_795_200L, link?.sizeBytes)
        assertEquals(listOf("http://tracker.example:6969/announce"), link?.trackers)
    }

    @Test
    fun decodesPlusAsSpaceLikeTheExtension() {
        val link = parseMagnet("magnet:?xt=urn:btih:$hex&dn=Ubuntu+desktop+24.04")

        assertEquals("Ubuntu desktop 24.04", link?.displayName)
    }

    @Test
    fun normalizesABase32InfoHash() {
        val link = parseMagnet("magnet:?xt=urn:btih:$base32&dn=Base32")

        assertEquals(hex, link?.infoHash)
    }

    @Test
    fun prefersTheFirstUsableXtParameter() {
        val link = parseMagnet(
            "magnet:?xt=urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&xt=urn:btih:$hex",
        )

        assertEquals(hex, link?.infoHash)
    }

    @Test
    fun parsesWebSeeds() {
        val link = parseMagnet(
            "magnet:?xt=urn:btih:$hex" +
                "&ws=https%3A%2F%2Fseed.example%2Ffile" +
                "&ws=https%3A%2F%2Fbackup.example%2Ffile",
        )

        assertEquals(
            listOf("https://seed.example/file", "https://backup.example/file"),
            link?.webSeeds,
        )
    }

    @Test
    fun ignoresMalformedOptionalFields() {
        val link = parseMagnet("magnet:?xt=urn:btih:not-a-hash&xl=abc&dn=")

        assertNull(link?.infoHash)
        assertNull(link?.sizeBytes)
        assertNull(link?.displayName)
    }

    @Test
    fun rejectsNonMagnetUris() {
        assertNull(parseMagnet("https://example.org/nebula.iso"))
        assertNull(parseMagnet("magnet:"))
        assertNull(parseMagnet(""))
    }

    @Test
    fun keepsMagnetWithoutAUsableHash() {
        val link = parseMagnet("magnet:?dn=no-hash&xl=42")

        assertNull(link?.infoHash)
        assertEquals("no-hash", link?.displayName)
        assertEquals(42L, link?.sizeBytes)
    }

    @Test
    fun checksTheScheme() {
        assertTrue(isMagnetLink("magnet:?xt=urn:btih:$hex"))
        assertTrue(isMagnetLink("  MAGNET:?xt=urn:btih:ABC  "))
        assertFalse(isMagnetLink("https://example.com"))
    }

    @Test
    fun findsAMagnetInWrappedText() {
        val magnet = "magnet:?xt=urn:btih:$hex&dn=Example"

        assertEquals(magnet, magnetFromText(magnet))
        assertEquals(magnet, magnetFromText("  $magnet  "))
        assertEquals(magnet, magnetFromText("Download: <$magnet>."))
        assertEquals(magnet, magnetFromText("(\"$magnet\")"))
    }

    @Test
    fun ignoresTextWithoutAUsableMagnet() {
        assertNull(magnetFromText(null))
        assertNull(magnetFromText(""))
        assertNull(magnetFromText("https://example.com/file.torrent"))
        assertNull(magnetFromText("magnet:"))
    }

    @Test
    fun labelsAMagnetByNameHashOrFallback() {
        assertEquals(
            "Name",
            magnetLabel(parseMagnet("magnet:?xt=urn:btih:$hex&dn=Name")!!),
        )
        assertEquals(
            hex.take(12),
            magnetLabel(parseMagnet("magnet:?xt=urn:btih:$hex")!!),
        )
        assertEquals(
            "Magnet link",
            magnetLabel(
                MagnetLink(
                    uri = "magnet:?dn=Name",
                    infoHash = null,
                    displayName = null,
                    sizeBytes = null,
                    trackers = emptyList(),
                ),
            ),
        )
    }

    @Test
    fun reducesTrackersToUniqueValidHosts() {
        val magnet = parseMagnet(
            "magnet:?xt=urn:btih:$hex" +
                "&tr=https%3A%2F%2Fa.example%2Fannounce" +
                "&tr=https%3A%2F%2Fa.example%2Fother" +
                "&tr=not-a-url" +
                "&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce",
        )

        assertEquals(listOf("a.example", "tracker.example"), trackerHosts(magnet!!))
    }
}
