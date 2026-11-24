package dev.remagnet.app.ui

import dev.remagnet.app.client.AddTorrentRequest
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.TorrentFileUpload
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.magnet.MagnetLink
import dev.remagnet.app.magnet.TorrentFileInfo
import dev.remagnet.app.magnet.magnetLabel
import dev.remagnet.app.magnet.torrentFileLabel

/** The states of the add flow that lives in a bottom sheet over the home screen. */
sealed interface AddSheetState {
    data object Closed : AddSheetState

    /** No usable torrent yet: the user can paste, share or choose one. */
    data class Paste(
        val draft: String = "",
        val error: String? = null,
    ) : AddSheetState

    /** A parsed magnet or `.torrent` file waiting for confirmation. */
    data class Review(
        val item: AddItem,
        val paused: Boolean = false,
        val duplicate: DuplicateState = DuplicateState.Checking,
        val submitting: Boolean = false,
        val error: String? = null,
    ) : AddSheetState {
        /**
         * Adding is blocked while the duplicate check runs, and when the client
         * already has the hash. A lookup failure still allows the attempt: the
         * add request reports the real error and the item stays available.
         */
        val canSubmit: Boolean
            get() = !submitting &&
                (duplicate is DuplicateState.Clear || duplicate is DuplicateState.Failed)
    }

    /** Confirmation shown after the client accepted the torrent. */
    data class Added(
        val name: String,
        val category: String,
        val tags: List<String>,
    ) : AddSheetState
}

/** A magnet link or a staged `.torrent` file, reduced to what review renders. */
sealed interface AddItem {
    /** Stable identity for the review, independent of the visible label. */
    val key: String

    val infoHash: String?

    val label: String

    val sizeBytes: Long?

    val trackers: List<String>

    val webSeeds: List<String>

    /** `null` for a magnet, whose metadata the client has not seen yet. */
    val fileCount: Int?

    val isPrivate: Boolean

    data class Magnet(val link: MagnetLink) : AddItem {
        override val key: String get() = link.uri
        override val infoHash: String? get() = link.infoHash
        override val label: String get() = magnetLabel(link)
        override val sizeBytes: Long? get() = link.sizeBytes
        override val trackers: List<String> get() = link.trackers
        override val webSeeds: List<String> get() = link.webSeeds
        override val fileCount: Int? get() = null
        override val isPrivate: Boolean get() = false
    }

    data class TorrentFile(
        val info: TorrentFileInfo,
        /** Where the intake staged the file until the add completes. */
        val stagedPath: String,
    ) : AddItem {
        override val key: String get() = stagedPath
        override val infoHash: String get() = info.infoHash
        override val label: String get() = torrentFileLabel(info)
        override val sizeBytes: Long? get() = info.sizeBytes
        override val trackers: List<String> get() = info.trackers
        override val webSeeds: List<String> get() = info.webSeeds
        override val fileCount: Int get() = info.fileCount
        override val isPrivate: Boolean get() = info.isPrivate
    }
}

/** The result of asking the client whether it already has this info hash. */
sealed interface DuplicateState {
    data object Checking : DuplicateState

    data object Clear : DuplicateState

    data class Existing(val torrent: TorrentSummary) : DuplicateState

    /** The lookup failed; adding may still work, so the sheet explains it. */
    data class Failed(val message: String) : DuplicateState

    /** The proxy is not configured, so there is nothing to check or add to. */
    data object NotConfigured : DuplicateState
}

/** Map a single-torrent lookup to the duplicate state the sheet renders. */
fun duplicateStateFor(result: QbitResult<TorrentSummary?>): DuplicateState = when (result) {
    is QbitResult.Success -> result.value
        ?.let { DuplicateState.Existing(it) }
        ?: DuplicateState.Clear

    is QbitResult.Failure -> DuplicateState.Failed(result.error.message)
}

/**
 * Build the proxy request for one magnet.
 *
 * Category and tags are deliberately absent: the proxy applies its configured
 * defaults, so the phone never has to know them before adding.
 */
fun addRequestFor(magnet: MagnetLink, paused: Boolean): AddTorrentRequest = AddTorrentRequest(
    urls = listOf(magnet.uri),
    paused = paused,
)

/**
 * Build the proxy request for one staged `.torrent` file.
 *
 * The bytes are the exact file the user reviewed, so the proxy parses the same
 * metainfo the sheet described.
 */
fun addRequestFor(
    file: TorrentFileInfo,
    bytes: ByteArray,
    paused: Boolean,
): AddTorrentRequest = AddTorrentRequest(
    files = listOf(TorrentFileUpload(filename = file.filename, bytes = bytes)),
    paused = paused,
)
