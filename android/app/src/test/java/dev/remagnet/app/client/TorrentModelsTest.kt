package dev.remagnet.app.client

import dev.remagnet.app.data.RemagnetSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TorrentModelsTest {
    @Test
    fun normalizesEveryKnownQBittorrentState() {
        val cases = mapOf(
            "allocating" to TorrentState.Checking,
            "checkingDL" to TorrentState.Checking,
            "checkingResumeData" to TorrentState.Checking,
            "checkingUP" to TorrentState.Checking,
            "metaDL" to TorrentState.Metadata,
            "downloading" to TorrentState.Downloading,
            "forcedDL" to TorrentState.Downloading,
            "stalledDL" to TorrentState.Stalled,
            "queuedDL" to TorrentState.Queued,
            "queuedUP" to TorrentState.Queued,
            "moving" to TorrentState.Moving,
            "uploading" to TorrentState.Seeding,
            "forcedUP" to TorrentState.Seeding,
            "stalledUP" to TorrentState.Seeding,
            "pausedDL" to TorrentState.Stopped,
            "pausedUP" to TorrentState.Stopped,
            "stoppedDL" to TorrentState.Stopped,
            "stoppedUP" to TorrentState.Stopped,
            "error" to TorrentState.Error,
            "missingFiles" to TorrentState.MissingFiles,
            "unknown" to TorrentState.Unknown,
        )

        cases.forEach { (raw, expected) ->
            assertEquals("$raw should map to $expected", expected, TorrentState.fromQbittorrent(raw))
        }
    }

    @Test
    fun keepsUnknownFutureStatesRenderable() {
        assertEquals(TorrentState.Unknown, TorrentState.fromQbittorrent("someNewState"))
    }

    @Test
    fun normalizesTagsFromStringsAndLists() {
        assertEquals(
            listOf("remagnet", "linux", "isos"),
            normalizeTagList(listOf(" remagnet, linux ", "isos", "remagnet")),
        )
        assertEquals(listOf("one", "two"), splitTagList(" one, ,two, one "))
        assertEquals(emptyList<String>(), splitTagList(null))
    }

    @Test
    fun treatsProgressAtTheThresholdAsComplete() {
        assertTrue(torrent(progress = COMPLETE_PROGRESS).isComplete)
        assertFalse(torrent(progress = 0.99).isComplete)
    }

    @Test
    fun aBlankFilterShowsEverything() {
        val filter = torrentFilterFor(
            RemagnetSettings(defaultCategory = "", defaultTags = ""),
        )

        assertFalse(filter.active)
        assertEquals(listOf(torrent(category = "tv")), filterTorrents(listOf(torrent(category = "tv")), filter))
    }

    @Test
    fun filtersByCategoryCaseInsensitively() {
        val filter = TorrentFilter(active = true, category = "Remagnet", tags = emptyList())

        assertTrue(matchesFilter(torrent(category = "remagnet"), filter))
        assertTrue(matchesFilter(torrent(category = " REMAGNET "), filter))
        assertFalse(matchesFilter(torrent(category = "films"), filter))
    }

    @Test
    fun matchesAnyConfiguredTag() {
        val filter = TorrentFilter(active = true, category = "", tags = listOf("linux", "isos"))

        assertTrue(matchesFilter(torrent(tags = listOf("Remagnet", "Linux")), filter))
        assertTrue(matchesFilter(torrent(tags = listOf("isos")), filter))
        assertFalse(matchesFilter(torrent(tags = listOf("films")), filter))
    }

    @Test
    fun buildsAFilterFromSettings() {
        val filter = torrentFilterFor(
            RemagnetSettings(defaultCategory = " remagnet ", defaultTags = "linux, isos"),
        )

        assertTrue(filter.active)
        assertEquals("remagnet", filter.category)
        assertEquals(listOf("linux", "isos"), filter.tags)
    }

    private fun torrent(
        category: String = "remagnet",
        tags: List<String> = listOf("remagnet"),
        progress: Double = 0.5,
    ) = TorrentSummary(
        hash = "abc",
        name = "Example",
        state = TorrentState.Downloading,
        rawState = "downloading",
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
