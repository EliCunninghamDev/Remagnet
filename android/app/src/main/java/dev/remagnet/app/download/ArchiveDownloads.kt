package dev.remagnet.app.download

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One archive request: everything a retry needs after a process restart. */
data class ArchiveRequest(
    val hash: String,
    val name: String,
    /** Torrent size when known, used as the progress denominator. */
    val size: Long,
)

/** The single archive download the app is allowed to run. */
sealed interface ArchiveDownloadState {
    data object Idle : ArchiveDownloadState

    data class Active(
        val hash: String,
        val name: String,
        val bytes: Long,
        val total: Long,
        val speed: Long,
    ) : ArchiveDownloadState {
        /** Null when the size is unknown, so the UI/notification go indeterminate. */
        val fraction: Float?
            get() = if (total > 0) (bytes.toDouble() / total).coerceIn(0.0, 1.0).toFloat() else null

        val percent: Int?
            get() = fraction?.let { (it * 100).toInt() }
    }

    data class Complete(
        val hash: String,
        val name: String,
        val fileName: String,
        val path: String,
        val bytes: Long,
    ) : ArchiveDownloadState

    data class Failed(
        val hash: String,
        val name: String,
        val message: String,
    ) : ArchiveDownloadState

    data class Cancelled(
        val hash: String,
        val name: String,
    ) : ArchiveDownloadState
}

/**
 * App-wide handoff between the foreground service and the UI.
 *
 * A download is claimed before the service starts, so a second tap is refused
 * immediately instead of being queued behind the first archive. Only the
 * active hash is reserved; a finished or failed state stays visible until the
 * user dismisses it or starts another download.
 */
object ArchiveDownloads {
    private val _state = MutableStateFlow<ArchiveDownloadState>(ArchiveDownloadState.Idle)
    val state: StateFlow<ArchiveDownloadState> = _state.asStateFlow()

    private val lock = Any()
    private var activeHash: String? = null

    /** Reserve the single slot. Returns false when another archive is running. */
    fun claim(hash: String, name: String, total: Long): Boolean = synchronized(lock) {
        val running = activeHash
        if (running != null && running != hash) return false

        activeHash = hash
        _state.value = ArchiveDownloadState.Active(
            hash = hash,
            name = name,
            bytes = 0,
            total = total.coerceAtLeast(0),
            speed = 0,
        )
        true
    }

    fun isActive(hash: String? = null): Boolean = synchronized(lock) {
        val running = activeHash ?: return false
        hash == null || running == hash
    }

    fun progress(hash: String, bytes: Long, total: Long, speed: Long) {
        val current = _state.value
        if (current !is ArchiveDownloadState.Active || current.hash != hash) return
        _state.value = current.copy(
            bytes = bytes.coerceAtLeast(0),
            total = total.coerceAtLeast(0),
            speed = speed.coerceAtLeast(0),
        )
    }

    fun complete(hash: String, name: String, fileName: String, path: String, bytes: Long) {
        synchronized(lock) {
            if (activeHash == hash) activeHash = null
        }
        _state.value = ArchiveDownloadState.Complete(
            hash = hash,
            name = name,
            fileName = fileName,
            path = path,
            bytes = bytes,
        )
    }

    fun fail(hash: String, name: String, message: String) {
        synchronized(lock) {
            if (activeHash == hash) activeHash = null
        }
        _state.value = ArchiveDownloadState.Failed(hash = hash, name = name, message = message)
    }

    fun cancel(hash: String, name: String) {
        synchronized(lock) {
            if (activeHash == hash) activeHash = null
        }
        _state.value = ArchiveDownloadState.Cancelled(hash = hash, name = name)
    }

    fun dismiss() {
        synchronized(lock) { activeHash = null }
        _state.value = ArchiveDownloadState.Idle
    }
}
