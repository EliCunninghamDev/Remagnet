package dev.remagnet.app.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TorrentListFilterTest {
    private fun torrent(
        hash: String = "0000000000000000000000000000000000000000",
        name: String = "Torrent",
        state: TorrentState = TorrentState.Downloading,
        progress: Double = 0.5,
        size: Long = 100,
        downloadSpeed: Long = 0,
        uploadSpeed: Long = 0,
    ) = TorrentSummary(
        hash = hash,
        name = name,
        state = state,
        rawState = state.label,
        progress = progress,
        size = size,
        downloadSpeed = downloadSpeed,
        uploadSpeed = uploadSpeed,
        eta = 60,
        ratio = 0.0,
        category = "",
        tags = emptyList(),
        seeds = 0,
        peers = 0,
    )

    @Test
    fun allMatchesEveryTorrent() {
        assertTrue(torrent().matchesFilter(TorrentFilter.All))
        assertTrue(
            torrent(state = TorrentState.Seeding, progress = 1.0).matchesFilter(TorrentFilter.All),
        )
        assertTrue(
            torrent(state = TorrentState.Stopped).matchesFilter(TorrentFilter.All),
        )
    }

    @Test
    fun activeMatchesIncompleteTorrentsThatAreNotPaused() {
        assertTrue(
            torrent(state = TorrentState.Downloading, progress = 0.4)
                .matchesFilter(TorrentFilter.Active),
        )
        assertTrue(
            torrent(state = TorrentState.Stalled, progress = 0.0)
                .matchesFilter(TorrentFilter.Active),
        )
        assertEquals(
            false,
            torrent(state = TorrentState.Seeding, progress = 1.0)
                .matchesFilter(TorrentFilter.Active),
        )
        assertEquals(
            false,
            torrent(state = TorrentState.Stopped, progress = 0.4)
                .matchesFilter(TorrentFilter.Active),
        )
    }

    @Test
    fun readyMatchesCompleteTorrentsIncludingPausedOnes() {
        assertTrue(
            torrent(state = TorrentState.Seeding, progress = 1.0)
                .matchesFilter(TorrentFilter.Ready),
        )
        assertTrue(
            torrent(state = TorrentState.Stopped, progress = 1.0)
                .matchesFilter(TorrentFilter.Ready),
        )
        assertEquals(
            false,
            torrent(state = TorrentState.Downloading, progress = 0.9)
                .matchesFilter(TorrentFilter.Ready),
        )
    }

    @Test
    fun aPausedCompleteTorrentLandsInBothReadyAndPaused() {
        val pausedComplete = torrent(state = TorrentState.Stopped, progress = 1.0)

        assertTrue(pausedComplete.matchesFilter(TorrentFilter.Ready))
        assertTrue(pausedComplete.matchesFilter(TorrentFilter.Paused))
    }

    @Test
    fun pausedMatchesStoppedTorrents() {
        assertTrue(
            torrent(state = TorrentState.Stopped, progress = 0.2)
                .matchesFilter(TorrentFilter.Paused),
        )
        assertEquals(
            false,
            torrent(state = TorrentState.Downloading).matchesFilter(TorrentFilter.Paused),
        )
    }

    @Test
    fun countsEachBucketLettingAPausedCompleteTorrentLandInBoth() {
        val list = listOf(
            torrent(state = TorrentState.Downloading, progress = 0.3),
            torrent(state = TorrentState.Seeding, progress = 1.0),
            torrent(state = TorrentState.Stopped, progress = 1.0),
            torrent(state = TorrentState.Stopped, progress = 0.2),
        )

        assertEquals(
            mapOf(
                TorrentFilter.All to 4,
                TorrentFilter.Active to 1,
                TorrentFilter.Ready to 2,
                TorrentFilter.Paused to 2,
            ),
            countTorrentFilters(list),
        )
    }

    @Test
    fun countsZeroedBucketsForAnEmptyList() {
        assertEquals(
            mapOf(
                TorrentFilter.All to 0,
                TorrentFilter.Active to 0,
                TorrentFilter.Ready to 0,
                TorrentFilter.Paused to 0,
            ),
            countTorrentFilters(emptyList()),
        )
    }

    @Test
    fun defaultsToAllTorrentsInInputOrder() {
        assertEquals(
            listOf("aaa111", "bbb222", "ccc333", "ddd444"),
            filterAndSortTorrents(sampleList()).map { it.hash },
        )
    }

    @Test
    fun filtersIntoEveryBucket() {
        val list = sampleList()

        assertEquals(
            listOf("aaa111", "bbb222", "ccc333", "ddd444"),
            filterAndSortTorrents(list, filter = TorrentFilter.All).map { it.hash },
        )
        assertEquals(
            listOf("aaa111"),
            filterAndSortTorrents(list, filter = TorrentFilter.Active).map { it.hash },
        )
        assertEquals(
            listOf("bbb222", "ccc333"),
            filterAndSortTorrents(list, filter = TorrentFilter.Ready).map { it.hash },
        )
        assertEquals(
            listOf("ccc333", "ddd444"),
            filterAndSortTorrents(list, filter = TorrentFilter.Paused).map { it.hash },
        )
    }

    @Test
    fun searchesNamesCaseInsensitivelyAndTrimsTheQuery() {
        val list = sampleList()

        assertEquals(
            listOf("bbb222", "ccc333", "ddd444"),
            filterAndSortTorrents(list, query = "  IMAGE ").map { it.hash },
        )
        assertEquals(
            listOf("aaa111"),
            filterAndSortTorrents(list, query = "ubuntu").map { it.hash },
        )
    }

    @Test
    fun searchesHashesCaseInsensitively() {
        assertEquals(
            listOf("ccc333"),
            filterAndSortTorrents(sampleList(), query = "CCC").map { it.hash },
        )
    }

    @Test
    fun returnsAnEmptyListWhenNothingMatches() {
        assertEquals(
            emptyList<TorrentSummary>(),
            filterAndSortTorrents(sampleList(), query = "nothing here"),
        )
    }

    @Test
    fun combinesSearchAndFilter() {
        assertEquals(
            listOf("ccc333", "ddd444"),
            filterAndSortTorrents(
                sampleList(),
                query = "image",
                filter = TorrentFilter.Paused,
            ).map { it.hash },
        )
    }

    @Test
    fun sortsByNameCaseInsensitively() {
        val mixedCase = listOf(
            torrent(hash = "1", name = "Zebra"),
            torrent(hash = "2", name = "apple"),
            torrent(hash = "3", name = "Banana"),
            torrent(hash = "4", name = "cherry"),
        )

        assertEquals(
            listOf("apple", "Banana", "cherry", "Zebra"),
            filterAndSortTorrents(mixedCase, sort = TorrentSort.Name).map { it.name },
        )
    }

    @Test
    fun sortsProgressDescending() {
        assertEquals(
            listOf("bbb222", "ccc333", "aaa111", "ddd444"),
            filterAndSortTorrents(sampleList(), sort = TorrentSort.Progress).map { it.hash },
        )
    }

    @Test
    fun sortsSizeDescending() {
        assertEquals(
            listOf("aaa111", "ccc333", "bbb222", "ddd444"),
            filterAndSortTorrents(sampleList(), sort = TorrentSort.Size).map { it.hash },
        )
    }

    @Test
    fun sortsSpeedDescendingBreakingTiesOnUploadSpeed() {
        val speeds = listOf(
            torrent(hash = "slow", downloadSpeed = 1, uploadSpeed = 100),
            torrent(hash = "tie-low-up", downloadSpeed = 5, uploadSpeed = 1),
            torrent(hash = "fast", downloadSpeed = 9, uploadSpeed = 0),
            torrent(hash = "tie-high-up", downloadSpeed = 5, uploadSpeed = 8),
        )

        assertEquals(
            listOf("fast", "tie-high-up", "tie-low-up", "slow"),
            filterAndSortTorrents(speeds, sort = TorrentSort.Speed).map { it.hash },
        )
    }

    @Test
    fun preservesOriginalOrderForTiesAcrossEverySort() {
        val ties = listOf(
            torrent(hash = "first", name = "Same", progress = 0.5, size = 10),
            torrent(hash = "second", name = "Same", progress = 0.5, size = 10),
            torrent(hash = "third", name = "Same", progress = 0.5, size = 10),
        )

        TorrentSort.entries.forEach { sort ->
            assertEquals(
                "sort=$sort",
                listOf("first", "second", "third"),
                filterAndSortTorrents(ties, sort = sort).map { it.hash },
            )
        }
    }

    @Test
    fun doesNotMutateTheInputList() {
        val list = sampleList()
        val snapshot = list.toList()

        filterAndSortTorrents(
            list,
            query = "image",
            filter = TorrentFilter.Ready,
            sort = TorrentSort.Name,
        )

        assertEquals(snapshot, list)
    }

    private fun sampleList() = listOf(
        torrent(
            hash = "aaa111",
            name = "Ubuntu ISO",
            state = TorrentState.Downloading,
            progress = 0.4,
            size = 400,
            downloadSpeed = 10,
            uploadSpeed = 1,
        ),
        torrent(
            hash = "bbb222",
            name = "debian image",
            state = TorrentState.Seeding,
            progress = 1.0,
            size = 200,
            downloadSpeed = 0,
            uploadSpeed = 5,
        ),
        torrent(
            hash = "ccc333",
            name = "Arch image",
            state = TorrentState.Stopped,
            progress = 1.0,
            size = 300,
            downloadSpeed = 0,
            uploadSpeed = 2,
        ),
        torrent(
            hash = "ddd444",
            name = "Fedora image",
            state = TorrentState.Stopped,
            progress = 0.25,
            size = 100,
            downloadSpeed = 0,
            uploadSpeed = 0,
        ),
    )
}
