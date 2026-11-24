package dev.remagnet.app.magnet

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

private const val PENDING_DIRECTORY = "pending-torrent"
private const val FALLBACK_FILENAME = "torrent.torrent"
private const val BUFFER_SIZE = 16 * 1024
private const val STALE_AFTER_MS = 24 * 60 * 60 * 1000L

/** The outcome of copying a shared `content://` torrent into app cache. */
sealed interface StagedTorrent {
    /** [bytes] is the parsed file content; [path] keeps it across process death. */
    data class Ready(
        val path: String,
        val filename: String,
        val bytes: ByteArray,
    ) : StagedTorrent

    data class Failed(val message: String) : StagedTorrent
}

/**
 * Keep shared `.torrent` files in the app cache.
 *
 * A `SavedStateHandle` only stores the staged path and filename, which stays
 * under Binder's transaction limit and survives process death after the
 * `content://` URI grant has expired.
 */
object PendingTorrentStore {
    fun stageFromUri(context: Context, uri: Uri): StagedTorrent {
        val filename = displayName(context, uri) ?: FALLBACK_FILENAME

        return try {
            val bytes = context.contentResolver.openInputStream(uri)?.use(::readCapped)
                ?: return StagedTorrent.Failed("The .torrent file could not be opened.")
            val directory = directory(context)
            if (!directory.isDirectory && !directory.mkdirs()) {
                return StagedTorrent.Failed("The .torrent file could not be saved on this device.")
            }

            val file = File(directory, "${UUID.randomUUID()}.torrent")
            file.writeBytes(bytes)
            StagedTorrent.Ready(file.absolutePath, filename, bytes)
        } catch (error: TorrentTooLargeException) {
            StagedTorrent.Failed(error.message ?: "The .torrent file is too large.")
        } catch (_: SecurityException) {
            StagedTorrent.Failed("Remagnet does not have permission to read that .torrent file.")
        } catch (_: IOException) {
            StagedTorrent.Failed("The .torrent file could not be read.")
        }
    }

    /** Read a previously staged file, refusing paths that grew past the limit. */
    fun readStaged(path: String): ByteArray? {
        val file = File(path)
        if (!file.isFile || file.length() > MAX_TORRENT_FILE_BYTES) return null
        return runCatching { file.readBytes() }.getOrNull()
    }

    /** Delete a staged file, ignoring missing files and unwritable cache dirs. */
    fun delete(path: String?) {
        if (path.isNullOrBlank()) return
        runCatching { File(path).delete() }
    }

    /**
     * Remove abandoned staging files.
     *
     * With [keepPath] every other file is an orphan from a superseded intake.
     * Without it, only files older than a day are removed so a pending intake
     * restored after process death is not deleted before it is read.
     */
    fun pruneStale(context: Context, keepPath: String? = null) {
        val keep = keepPath?.let { File(it).absolutePath }
        val cutoff = System.currentTimeMillis() - STALE_AFTER_MS
        val files = directory(context).listFiles() ?: return

        for (file in files) {
            if (!file.isFile) continue
            if (keep != null && file.absolutePath == keep) continue
            if (keep != null || file.lastModified() < cutoff) {
                runCatching { file.delete() }
            }
        }
    }

    private fun directory(context: Context): File =
        File(context.cacheDir, PENDING_DIRECTORY)

    private fun displayName(context: Context, uri: Uri): String? {
        return runCatching {
            context.contentResolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index < 0 || !cursor.moveToFirst()) return@use null
                    cursor.getString(index)?.trim()?.takeIf { it.isNotEmpty() }
                }
        }.getOrNull()
    }

    /**
     * Read at most `MAX + 1` bytes so a hostile or huge content provider cannot
     * exhaust memory before the size check runs.
     */
    private fun readCapped(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(BUFFER_SIZE)
        var remaining = MAX_TORRENT_FILE_BYTES + 1

        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size, remaining))
            if (read == -1) break
            output.write(buffer, 0, read)
            remaining -= read
        }

        val bytes = output.toByteArray()
        if (bytes.size > MAX_TORRENT_FILE_BYTES) {
            throw TorrentTooLargeException(
                "The .torrent file is too large. The maximum is 10 MiB.",
            )
        }
        return bytes
    }

    private class TorrentTooLargeException(message: String) : IOException(message)
}
