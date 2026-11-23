package dev.remagnet.app.ui

import dev.remagnet.app.client.AddTorrentRequest
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.magnet.MagnetLink

/** The states of the add flow that lives in a bottom sheet over the home screen. */
sealed interface AddSheetState {
    data object Closed : AddSheetState

    /** No usable magnet yet: the user can paste or share one. */
    data class Paste(
        val draft: String = "",
        val error: String? = null,
    ) : AddSheetState

    /** A parsed magnet waiting for confirmation. */
    data class Review(
        val magnet: MagnetLink,
        val paused: Boolean = false,
        val duplicate: DuplicateState = DuplicateState.Checking,
        val submitting: Boolean = false,
        val error: String? = null,
    ) : AddSheetState {
        /**
         * Adding is blocked while the duplicate check runs, and when the client
         * already has the hash. A lookup failure still allows the attempt: the
         * add request reports the real error and the magnet stays available.
         */
        val canSubmit: Boolean
            get() = !submitting &&
                (duplicate is DuplicateState.Clear || duplicate is DuplicateState.Failed)
    }

    /** Confirmation shown after the client accepted the magnet. */
    data class Added(
        val name: String,
        val category: String,
        val tags: List<String>,
    ) : AddSheetState
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
