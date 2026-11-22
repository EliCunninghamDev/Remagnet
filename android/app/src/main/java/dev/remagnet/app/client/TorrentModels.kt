package dev.remagnet.app.client

import dev.remagnet.app.data.RemagnetSettings
import java.util.Locale

/** Progress at or above this value is treated as complete everywhere. */
const val COMPLETE_PROGRESS = 0.999_999

/**
 * A normalized torrent lifecycle state.
 *
 * qBittorrent reports six checking, queued and stopped variants. Collapsing
 * them here keeps labels and colours out of the transport layer; unknown
 * future states still render as [Unknown] instead of crashing.
 */
enum class TorrentState(val label: String) {
    Checking("Checking"),
    Metadata("Fetching metadata"),
    Downloading("Downloading"),
    Stalled("Stalled"),
    Queued("Queued"),
    Moving("Moving"),
    Seeding("Seeding"),
    Stopped("Stopped"),
    Error("Error"),
    MissingFiles("Missing files"),
    Unknown("Unknown"),
    ;

    companion object {
        /** Translate a qBittorrent state name into the client-neutral set. */
        fun fromQbittorrent(raw: String): TorrentState = when (raw) {
            "allocating", "checkingDL", "checkingResumeData", "checkingUP" -> Checking
            "metaDL" -> Metadata
            "downloading", "forcedDL" -> Downloading
            "stalledDL" -> Stalled
            "queuedDL", "queuedUP" -> Queued
            "moving" -> Moving
            "uploading", "forcedUP", "stalledUP" -> Seeding
            "pausedDL", "pausedUP", "stoppedDL", "stoppedUP" -> Stopped
            "error" -> Error
            "missingFiles" -> MissingFiles
            else -> Unknown
        }
    }
}

/** The subset of a torrent the list and add flow need to render. */
data class TorrentSummary(
    val hash: String,
    val name: String,
    val state: TorrentState,
    /** The original qBittorrent state, kept for diagnostics. */
    val rawState: String,
    /** Fraction complete, 0..1. */
    val progress: Double,
    val size: Long,
    val downloadSpeed: Long,
    val uploadSpeed: Long,
    /** Seconds remaining, or [ETA_UNKNOWN] when the client cannot estimate. */
    val eta: Long,
    val ratio: Double,
    val category: String,
    val tags: List<String>,
    val seeds: Int,
    val peers: Int,
    val addedOn: Long,
) {
    val isComplete: Boolean
        get() = progress >= COMPLETE_PROGRESS || state == TorrentState.Seeding
}

/** qBittorrent reports this ETA when it has no estimate. */
const val ETA_UNKNOWN = 8_640_000L

/** Categories and tags available on the configured client. */
data class TorrentTaxonomy(
    val categories: List<String>,
    val tags: List<String>,
)

/** Versions returned by a successful direct connection test. */
data class ConnectionDetails(
    val appVersion: String,
    val webApiVersion: String,
)

/** A request to add one or more magnet links or torrent URLs. */
data class AddTorrentRequest(
    val urls: List<String>,
    val category: String = "",
    val tags: List<String> = emptyList(),
    val paused: Boolean = false,
)

data class AddTorrentResult(
    val added: Int,
    /** Info hashes parsed from the submitted magnet links. */
    val hashes: List<String>,
)

/**
 * Which torrents the app treats as Remagnet's own.
 *
 * Remagnet adds torrents with the configured category and tags, so the list can
 * hide unrelated torrents in a shared client. With both defaults blank there is
 * no way to tell them apart, so everything is shown.
 */
data class TorrentFilter(
    val active: Boolean,
    val category: String,
    val tags: List<String>,
)

fun torrentFilterFor(settings: RemagnetSettings): TorrentFilter {
    val category = settings.defaultCategory.trim()
    val tags = splitTagList(settings.defaultTags)
    return TorrentFilter(
        active = category.isNotEmpty() || tags.isNotEmpty(),
        category = category,
        tags = tags,
    )
}

fun filterTorrents(torrents: List<TorrentSummary>, filter: TorrentFilter): List<TorrentSummary> =
    if (!filter.active) torrents else torrents.filter { matchesFilter(it, filter) }

fun matchesFilter(torrent: TorrentSummary, filter: TorrentFilter): Boolean {
    if (!filter.active) return true
    if (filter.category.isNotEmpty() && sameName(torrent.category, filter.category)) return true

    val torrentTags = torrent.tags.map(::foldTag).toSet()
    return filter.tags.any { foldTag(it) in torrentTags }
}

/**
 * Split, trim and de-duplicate user-entered tags. Client tags are a flat list,
 * so a comma inside one string is treated as a separator.
 */
fun normalizeTagList(tags: Iterable<String>): List<String> {
    val seen = LinkedHashSet<String>()
    for (raw in tags) {
        for (part in raw.split(',')) {
            val tag = part.trim()
            if (tag.isNotEmpty()) seen += tag
        }
    }
    return seen.toList()
}

fun splitTagList(raw: String?): List<String> = normalizeTagList(listOf(raw.orEmpty()))

private fun foldTag(value: String): String = value.trim().lowercase(Locale.ROOT)

private fun sameName(left: String, right: String): Boolean = foldTag(left) == foldTag(right)
