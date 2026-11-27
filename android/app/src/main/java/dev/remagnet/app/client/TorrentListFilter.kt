package dev.remagnet.app.client

/** The list buckets a user can filter torrents into. */
enum class TorrentFilter(val label: String) {
    All("All"),
    Active("Active"),
    Ready("Ready"),
    Paused("Paused"),
}

/** The orders a user can sort the torrent list by. */
enum class TorrentSort(val label: String) {
    Added("Newest"),
    Name("Name"),
    Progress("Progress"),
    Size("Size"),
    Speed("Speed"),
}

/**
 * Whether a torrent belongs in a filter bucket.
 *
 * A paused torrent can also be complete, so [TorrentFilter.Ready] and
 * [TorrentFilter.Paused] overlap on purpose: the user can find a finished
 * torrent either way.
 */
fun TorrentSummary.matchesFilter(filter: TorrentFilter): Boolean = when (filter) {
    TorrentFilter.All -> true
    TorrentFilter.Active -> !isComplete && state != TorrentState.Stopped
    TorrentFilter.Ready -> isComplete
    TorrentFilter.Paused -> state == TorrentState.Stopped
}

/** Count the torrents in each filter bucket. */
fun countTorrentFilters(torrents: List<TorrentSummary>): Map<TorrentFilter, Int> =
    TorrentFilter.entries.associateWith { filter ->
        torrents.count { it.matchesFilter(filter) }
    }

/**
 * Filter and sort a torrent list without touching the input list.
 *
 * Ties keep their original order, which keeps polling refreshes from making
 * equally ranked rows jump around.
 */
fun filterAndSortTorrents(
    torrents: List<TorrentSummary>,
    query: String = "",
    filter: TorrentFilter = TorrentFilter.All,
    sort: TorrentSort = TorrentSort.Added,
): List<TorrentSummary> {
    val needle = query.trim()
    val filtered = torrents.filter { torrent ->
        torrent.matchesFilter(filter) &&
            (needle.isEmpty() ||
                torrent.name.contains(needle, ignoreCase = true) ||
                torrent.hash.contains(needle, ignoreCase = true))
    }

    if (sort == TorrentSort.Added) return filtered

    val comparator: Comparator<TorrentSummary> = when (sort) {
        TorrentSort.Added -> return filtered
        TorrentSort.Name -> Comparator { a, b ->
            a.name.compareTo(b.name, ignoreCase = true)
        }
        TorrentSort.Progress -> Comparator { a, b ->
            compareValues(b.progress, a.progress)
        }
        TorrentSort.Size -> Comparator { a, b ->
            compareValues(b.size, a.size)
        }
        TorrentSort.Speed -> Comparator { a, b ->
            val byDownload = compareValues(b.downloadSpeed, a.downloadSpeed)
            if (byDownload != 0) byDownload else compareValues(b.uploadSpeed, a.uploadSpeed)
        }
    }
    return filtered.sortedWith(comparator)
}
