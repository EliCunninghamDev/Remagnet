package dev.remagnet.app.magnet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MagnetLinkTest {
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
    fun rejectsNonMagnetUris() {
        assertNull(parseMagnet("https://example.org/nebula.iso"))
        assertNull(parseMagnet(""))
    }

    @Test
    fun keepsMagnetWithoutAUsableHash() {
        val link = parseMagnet("magnet:?dn=no-hash&xl=42")

        assertNull(link?.infoHash)
        assertEquals("no-hash", link?.displayName)
        assertEquals(42L, link?.sizeBytes)
    }
}
