package dev.remagnet.app.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TorrentModelsTest {
    @Test
    fun normalizesEveryKnownProxyState() {
        val cases = mapOf(
            "checking" to TorrentState.Checking,
            "metadata" to TorrentState.Metadata,
            "downloading" to TorrentState.Downloading,
            "stalled" to TorrentState.Stalled,
            "queued" to TorrentState.Queued,
            "moving" to TorrentState.Moving,
            "seeding" to TorrentState.Seeding,
            "stopped" to TorrentState.Stopped,
            "error" to TorrentState.Error,
            "missingfiles" to TorrentState.MissingFiles,
            "unknown" to TorrentState.Unknown,
        )

        cases.forEach { (raw, expected) ->
            assertEquals("$raw should map to $expected", expected, TorrentState.fromProxy(raw))
        }
    }

    @Test
    fun keepsUnknownFutureStatesRenderable() {
        assertEquals(TorrentState.Unknown, TorrentState.fromProxy("someNewState"))
    }

    @Test
    fun stateNamesAreMatchedCaseInsensitively() {
        assertEquals(TorrentState.Downloading, TorrentState.fromProxy(" DOWNLOADING "))
    }

    @Test
    fun treatsProgressAtTheThresholdAsComplete() {
        assertTrue(torrent(progress = COMPLETE_PROGRESS).isComplete)
        assertFalse(torrent(progress = 0.99).isComplete)
    }

    @Test
    fun treatsSeedingAsCompleteRegardlessOfProgress() {
        assertTrue(torrent(progress = 0.5, state = TorrentState.Seeding).isComplete)
    }

    @Test
    fun theAddRequestSendsOnlyUrlsAndPaused() {
        val request = AddTorrentRequest(urls = listOf("magnet:?xt=urn:btih:abc"), paused = true)

        assertEquals(listOf("magnet:?xt=urn:btih:abc"), request.urls)
        assertTrue(request.paused)
    }

    @Test
    fun theAddResultCarriesTheProxyAppliedMetadata() {
        val result = AddTorrentResult(
            added = 1,
            hashes = listOf("abc"),
            category = "remagnet",
            tags = listOf("linux"),
        )

        assertEquals(1, result.added)
        assertEquals("remagnet", result.category)
        assertEquals(listOf("linux"), result.tags)
    }

    private fun torrent(
        category: String = "remagnet",
        tags: List<String> = listOf("remagnet"),
        progress: Double = 0.5,
        state: TorrentState = TorrentState.Downloading,
    ) = TorrentSummary(
        hash = "abc",
        name = "Example",
        state = state,
        rawState = state.label,
        progress = progress,
        size = 1024,
        downloadSpeed = 100,
        uploadSpeed = 10,
        eta = 60,
        ratio = 0.1,
        category = category,
        tags = tags,
        seeds = 2,
        peers = 3,
        addedOn = 0,
    )
}
