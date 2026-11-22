package dev.remagnet.app.magnet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MagnetIntakeTest {
    private val hash = "d540fc48eb12f2833163eed6421d449dd8f1ce1f"
    private val magnet = "magnet:?xt=urn:btih:$hash&dn=Ubuntu"

    @Test
    fun viewIntentCarriesAMagnetUri() {
        val intake = extractMagnetIntake(ACTION_VIEW, magnet, text = null)

        assertEquals(MagnetIntake.Magnet(magnet), intake)
    }

    @Test
    fun viewSchemeIsCaseInsensitiveAndTrimmed() {
        val intake = extractMagnetIntake(
            ACTION_VIEW,
            "  MAGNET:?xt=urn:btih:$hash&dn=Example  ",
            text = null,
        )

        assertEquals(MagnetIntake.Magnet("MAGNET:?xt=urn:btih:$hash&dn=Example"), intake)
    }

    @Test
    fun shareIntentFindsAMagnetInsideText() {
        val intake = extractMagnetIntake(
            ACTION_SEND,
            data = null,
            text = "Download this: <$magnet>.",
        )

        assertEquals(MagnetIntake.Magnet(magnet), intake)
    }

    @Test
    fun shareIntentUsesTheFirstMagnet() {
        val second = "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=Second"

        val intake = extractMagnetIntake(
            ACTION_SEND,
            data = null,
            text = "$magnet\r\n$second",
        )

        assertEquals(MagnetIntake.Magnet(magnet), intake)
    }

    @Test
    fun shareIntentWithoutAMagnetKeepsTheDraft() {
        val intake = extractMagnetIntake(ACTION_SEND, data = null, text = "look at this")

        assertEquals(
            MagnetIntake.Unusable("look at this", NOT_A_MAGNET_MESSAGE),
            intake,
        )
    }

    @Test
    fun magnetWithoutAHashIsReportedButKept() {
        val intake = extractMagnetIntake(ACTION_SEND, data = null, text = "magnet:?dn=no-hash")

        assertEquals(
            MagnetIntake.Unusable("magnet:?dn=no-hash", NO_HASH_MESSAGE),
            intake,
        )
    }

    @Test
    fun usableTextRescuesAMalformedViewData() {
        val intake = extractMagnetIntake(ACTION_VIEW, "magnet:?dn=no-hash", magnet)

        assertEquals(MagnetIntake.Magnet(magnet), intake)
    }

    @Test
    fun viewDataWinsOverText() {
        val other = "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=Other"

        val intake = extractMagnetIntake(ACTION_VIEW, magnet, other)

        assertEquals(MagnetIntake.Magnet(magnet), intake)
    }

    @Test
    fun aLauncherStartHasNoIntake() {
        assertEquals(
            MagnetIntake.None,
            extractMagnetIntake("android.intent.action.MAIN", data = null, text = null),
        )
    }

    @Test
    fun aViewOfSomethingElseHasNoIntake() {
        assertEquals(
            MagnetIntake.None,
            extractMagnetIntake(ACTION_VIEW, "https://example.com/file.torrent", null),
        )
    }

    @Test
    fun blankShareTextHasNoIntake() {
        assertEquals(
            MagnetIntake.None,
            extractMagnetIntake(ACTION_SEND, data = null, text = "   "),
        )
    }

    @Test
    fun sendMultipleIsTreatedAsAShare() {
        val intake = extractMagnetIntake(ACTION_SEND_MULTIPLE, data = null, text = magnet)

        assertTrue(intake is MagnetIntake.Magnet)
    }
}
