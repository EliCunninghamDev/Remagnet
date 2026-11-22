package dev.remagnet.app.ui

import dev.remagnet.app.client.QbitError
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.magnet.MagnetLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AddMagnetStateTest {
    private val magnet = MagnetLink(
        uri = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
        infoHash = "0123456789abcdef0123456789abcdef01234567",
        displayName = "Ubuntu",
        sizeBytes = 1024,
        trackers = emptyList(),
    )

    @Test
    fun aMissingTorrentIsClear() {
        assertEquals(
            DuplicateState.Clear,
            duplicateStateFor(QbitResult.Success(null)),
        )
    }

    @Test
    fun anExistingTorrentBlocksTheAdd() {
        val torrent = torrent()

        val duplicate = duplicateStateFor(QbitResult.Success(torrent))

        assertTrue(duplicate is DuplicateState.Existing)
        assertEquals(torrent, (duplicate as DuplicateState.Existing).torrent)
    }

    @Test
    fun aFailedLookupKeepsItsMessage() {
        val duplicate = duplicateStateFor(
            QbitResult.Failure(QbitError.Unreachable("Could not reach qBittorrent.")),
        )

        assertEquals(
            DuplicateState.Failed("Could not reach qBittorrent."),
            duplicate,
        )
    }

    @Test
    fun submitIsBlockedWhileCheckingAndForADuplicate() {
        assertFalse(review(DuplicateState.Checking).canSubmit)
        assertFalse(review(DuplicateState.Existing(torrent())).canSubmit)
        assertFalse(review(DuplicateState.NotConfigured).canSubmit)
        assertTrue(review(DuplicateState.Clear).canSubmit)
    }

    @Test
    fun aFailedLookupStillAllowsTheAttempt() {
        assertTrue(review(DuplicateState.Failed("offline")).canSubmit)
    }

    @Test
    fun submitIsBlockedWhileASendIsRunning() {
        assertFalse(review(DuplicateState.Clear, submitting = true).canSubmit)
    }

    @Test
    fun theAddRequestUsesTheConfiguredDefaults() {
        val settings = RemagnetSettings(
            defaultCategory = "  remagnet  ",
            defaultTags = "remagnet, linux, remagnet",
        )

        val request = addRequestFor(settings, magnet, paused = true)

        assertEquals(listOf(magnet.uri), request.urls)
        assertEquals("remagnet", request.category)
        assertEquals(listOf("remagnet", "linux"), request.tags)
        assertTrue(request.paused)
    }

    @Test
    fun blankDefaultsSendNoCategoryOrTags() {
        val settings = RemagnetSettings(defaultCategory = "", defaultTags = "")

        val request = addRequestFor(settings, magnet, paused = false)

        assertEquals("", request.category)
        assertEquals(emptyList<String>(), request.tags)
        assertFalse(request.paused)
    }

    private fun review(
        duplicate: DuplicateState,
        submitting: Boolean = false,
    ) = AddSheetState.Review(
        magnet = magnet,
        duplicate = duplicate,
        submitting = submitting,
    )

    private fun torrent() = TorrentSummary(
        hash = magnet.infoHash!!,
        name = "Ubuntu ISO",
        state = TorrentState.Seeding,
        rawState = "stalledUP",
        progress = 1.0,
        size = 4_294_967_296,
        downloadSpeed = 0,
        uploadSpeed = 2048,
        eta = 8_640_000,
        ratio = 1.5,
        category = "remagnet",
        tags = listOf("remagnet"),
        seeds = 3,
        peers = 4,
        addedOn = 1_700_000_000,
    )
}
