package dev.remagnet.app.client

import java.util.Locale

/** Progress at or above this value is treated as complete everywhere. */
const val COMPLETE_PROGRESS = 0.999_999

/** qBittorrent's sentinel for an unknown ETA, passed through by the proxy. */
const val ETA_UNKNOWN = 8_640_000L

/**
 * A normalized torrent lifecycle state.
 *
 * The proxy normalizes qBittorrent's vocabulary before the response reaches
 * the app; unknown future states still render as [Unknown] instead of crashing.
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
        /** Translate the proxy's neutral state name into this enum. */
        fun fromProxy(raw: String): TorrentState = when (raw.trim().lowercase(Locale.ROOT)) {
            "checking" -> Checking
            "metadata" -> Metadata
            "downloading" -> Downloading
            "stalled" -> Stalled
            "queued" -> Queued
            "moving" -> Moving
            "seeding" -> Seeding
            "stopped" -> Stopped
            "error" -> Error
            "missingfiles" -> MissingFiles
            else -> Unknown
        }
    }
}

/** The subset of a torrent the list and add flow need to render. */
data class TorrentSummary(
    val hash: String,
    val name: String,
    val state: TorrentState,
    /** The proxy's state string, kept for diagnostics. */
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
    /** The proxy does not expose an added time; kept for callers that sort. */
    val addedOn: Long = 0,
) {
    val isComplete: Boolean
        get() = progress >= COMPLETE_PROGRESS || state == TorrentState.Seeding
}

/** Versions and defaults returned by a successful connection test. */
data class ConnectionDetails(
    val clientLabel: String,
    val appVersion: String,
    val webApiVersion: String,
    val pauseOnAdd: Boolean = false,
    val defaultCategory: String = "",
    val defaultTags: List<String> = emptyList(),
)

/** A request to add one or more magnet links or torrent URLs. */
data class AddTorrentRequest(
    val urls: List<String>,
    val paused: Boolean = false,
)

data class AddTorrentResult(
    val added: Int,
    /** Info hashes parsed from the submitted magnet links. */
    val hashes: List<String>,
    /** Category the proxy applied. */
    val category: String = "",
    /** Tags the proxy applied. */
    val tags: List<String> = emptyList(),
)
