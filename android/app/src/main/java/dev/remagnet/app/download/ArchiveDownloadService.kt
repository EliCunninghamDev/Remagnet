package dev.remagnet.app.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import dev.remagnet.app.MainActivity
import dev.remagnet.app.R
import dev.remagnet.app.data.settingsRepositoryFor
import dev.remagnet.app.data.validateProxySettings
import dev.remagnet.app.util.formatBytes
import dev.remagnet.app.util.formatSpeed
import java.io.File
import java.io.IOException
import java.io.InputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Streams one archive from the proxy into the app's Downloads folder.
 *
 * A foreground service keeps the token in an authorization header (unlike
 * `DownloadManager`, which would need it in the URL) and lets Remagnet render
 * live bytes and speed. The service owns the download; the activity only
 * observes [ArchiveDownloads].
 */
class ArchiveDownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private var current: ArchiveRequest? = null

    @Volatile
    private var activeStream: InputStream? = null

    @Volatile
    private var cancelRequested = false

    private var lastNotifyAt = 0L

    private var lastNotification: Notification? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val request = intent.toRequest()
                if (request == null) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                startDownload(request)
            }

            ACTION_CANCEL -> cancelDownload()

            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        runCatching { activeStream?.close() }
        activeStream = null
        // A cancelled coroutine reports its own failure or cancellation, so
        // this does not overwrite a completed state during a normal stop.
        super.onDestroy()
    }

    private fun startDownload(request: ArchiveRequest) {
        if (job?.isActive == true) {
            // A second tap for the same torrent is a duplicate delivery, not a
            // second download. A different hash is refused by the ViewModel.
            // Re-post the live notification so this start request still has
            // its foreground call, as the platform requires.
            startForegroundSafely(
                lastNotification ?: progressNotification(request, bytes = 0, total = 0, speed = 0),
            )
            return
        }

        cancelRequested = false
        if (!ArchiveDownloads.claim(request.hash, request.name, request.size)) {
            startForegroundSafely(busyNotification())
            scope.launch {
                delay(STOP_IDLE_DELAY_MS)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            return
        }

        current = request
        lastNotifyAt = 0
        val notification = progressNotification(request, bytes = 0, total = 0, speed = 0)
        lastNotification = notification
        startForegroundSafely(notification)
        job = scope.launch { runDownload(request) }
    }

    private suspend fun runDownload(request: ArchiveRequest) {
        var part: File? = null
        var completed = false

        try {
            val settings = settingsRepositoryFor(this).load()
            if (!settings.proxyConfigured || validateProxySettings(settings).isNotEmpty()) {
                throw ArchiveFailure("Configure the Remagnet Proxy URL and token in Settings.")
            }

            val opened = ArchiveDownloader(
                baseUrl = settings.proxyBaseUrl,
                token = settings.proxyToken,
            ).open(request.hash, request.fileIndex)
            if (opened is ArchiveOpenResult.Failed) throw ArchiveFailure(opened.message)
            opened as ArchiveOpenResult.Ready
            activeStream = opened.stream

            // The ZIP is produced while it streams, so its own length is
            // usually missing. The torrent size is close enough for a smoothed
            // determinate bar and keeps the notification informative.
            val total = when {
                request.size > 0 -> request.size
                opened.contentLength > 0 -> opened.contentLength
                else -> 0L
            }

            val directory = archiveDirectory(this)
            val target = uniqueDownloadFile(
                directory,
                safeDownloadName(
                    opened.suggestedName ?: request.name,
                    fallbackIsZip = opened.suggestedName == null && request.fileIndex == null,
                ),
            )
            part = File(directory, "${target.name}.part")

            val meter = SpeedMeter()
            var bytes = 0L
            part.outputStream().buffered().use { output ->
                val buffer = ByteArray(COPY_BUFFER_BYTES)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val read = opened.stream.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    bytes += read
                    emitProgress(request, bytes, total, meter.sample(bytes))
                }
                output.flush()
            }

            currentCoroutineContext().ensureActive()
            if (cancelRequested) throw CancellationException()

            val saved = if (part.renameTo(target)) {
                target
            } else {
                part.copyTo(target, overwrite = true)
                part.delete()
                target
            }

            completed = true
            ArchiveDownloads.complete(
                hash = request.hash,
                name = request.name,
                fileName = saved.name,
                path = saved.absolutePath,
                bytes = bytes,
            )
            finishWith(completeNotification(saved.name, saved.absolutePath))
        } catch (cancelled: CancellationException) {
            if (cancelRequested) {
                finishCancelled(request)
            } else {
                finishFailed(request, "The download stopped before it finished.")
            }
        } catch (failure: ArchiveFailure) {
            finishFailed(request, failure.message ?: "The archive download failed.")
        } catch (_: IOException) {
            if (cancelRequested) {
                finishCancelled(request)
            } else {
                finishFailed(request, "The download connection dropped. Retry to start again.")
            }
        } catch (error: Exception) {
            finishFailed(request, error.message ?: "The archive download failed.")
        } finally {
            runCatching { activeStream?.close() }
            activeStream = null
            if (!completed) deleteQuietly(part)
        }
    }

    private fun emitProgress(
        request: ArchiveRequest,
        bytes: Long,
        total: Long,
        speed: Long,
    ) {
        val now = SystemClock.elapsedRealtime()
        // Byte counts change much faster than a notification needs to; four
        // updates per second are enough for the system's progress animation.
        if (now - lastNotifyAt < UPDATE_INTERVAL_MS) return

        lastNotifyAt = now
        ArchiveDownloads.progress(request.hash, bytes, total, speed)
        val notification = progressNotification(request, bytes, total, speed)
        lastNotification = notification
        notificationManager().notify(NOTIFICATION_ID, notification)
    }

    private fun cancelDownload() {
        cancelRequested = true
        job?.cancel()
        runCatching { activeStream?.close() }

        if (job == null) {
            current?.let { ArchiveDownloads.cancel(it.hash, it.name) }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun finishCancelled(request: ArchiveRequest) {
        ArchiveDownloads.cancel(request.hash, request.name)
        finishWith(cancelledNotification(request))
    }

    private fun finishFailed(request: ArchiveRequest, message: String) {
        ArchiveDownloads.fail(request.hash, request.name, message)
        finishWith(failedNotification(request, message))
    }

    private fun finishWith(notification: Notification) {
        notificationManager().notify(NOTIFICATION_ID, notification)
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    private fun startForegroundSafely(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun progressNotification(
        request: ArchiveRequest,
        bytes: Long,
        total: Long,
        speed: Long,
    ): Notification {
        val indeterminate = total <= 0
        val permille = if (indeterminate) {
            0
        } else {
            ((bytes.toDouble() / total) * 1000.0).toInt().coerceIn(0, 1000)
        }

        val transferred = buildString {
            append(formatBytes(bytes))
            if (!indeterminate) {
                append(" of ")
                append(formatBytes(total))
            }
            if (speed > 0) {
                append(" · ")
                append(formatSpeed(speed))
            }
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_download)
            .setContentTitle(request.name)
            .setContentText(transferred)
            .setSubText("Downloading")
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(PROGRESS_MAX, permille, indeterminate)
            .addAction(0, "Cancel", cancelIntent())
            .build()
    }

    private fun completeNotification(fileName: String, path: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_download)
            .setContentTitle("Download ready")
            .setContentText(fileName)
            .setContentIntent(openArchiveIntent(path))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .addAction(0, "Open", openArchiveIntent(path))
            .build()

    private fun failedNotification(request: ArchiveRequest, message: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_download)
            .setContentTitle("Download failed")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .addAction(0, "Retry", startIntent(request))
            .addAction(0, "Dismiss", dismissIntent())
            .build()

    private fun cancelledNotification(request: ArchiveRequest): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_download)
            .setContentTitle("Download cancelled")
            .setContentText(request.name)
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .addAction(0, "Retry", startIntent(request))
            .addAction(0, "Dismiss", dismissIntent())
            .build()

    private fun busyNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_download)
            .setContentTitle("Another archive is downloading")
            .setContentText("Remagnet downloads one archive at a time.")
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()

    private fun openAppIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(this, REQUEST_OPEN_APP, intent, pendingFlags())
    }

    private fun openArchiveIntent(path: String): PendingIntent {
        val intent = Intent(this, OpenArchiveActivity::class.java)
            .putExtra(OpenArchiveActivity.EXTRA_PATH, path)
        return PendingIntent.getActivity(this, REQUEST_OPEN_ARCHIVE, intent, pendingFlags())
    }

    private fun cancelIntent(): PendingIntent =
        PendingIntent.getService(
            this,
            REQUEST_CANCEL,
            baseIntent().setAction(ACTION_CANCEL),
            pendingFlags(),
        )

    private fun dismissIntent(): PendingIntent =
        PendingIntent.getBroadcast(
            this,
            REQUEST_DISMISS,
            Intent(this, ArchiveDismissReceiver::class.java),
            pendingFlags(),
        )

    private fun startIntent(request: ArchiveRequest): PendingIntent =
        PendingIntent.getForegroundService(
            this,
            REQUEST_RETRY,
            baseIntent()
                .setAction(ACTION_START)
                .putExtra(EXTRA_HASH, request.hash)
                .putExtra(EXTRA_NAME, request.name)
                .putExtra(EXTRA_SIZE, request.size)
                .putExtra(EXTRA_FILE_INDEX, request.fileIndex ?: -1L),
            pendingFlags(),
        )

    private fun pendingFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private fun createChannel() {
        val manager = notificationManager()
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Archive downloads",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Progress and results for ZIP downloads through the Remagnet proxy."
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    private fun notificationManager(): NotificationManager =
        getSystemService(NotificationManager::class.java)

    private fun baseIntent(): Intent = Intent(this, ArchiveDownloadService::class.java)

    private fun Intent.toRequest(): ArchiveRequest? {
        val hash = getStringExtra(EXTRA_HASH) ?: return null
        return ArchiveRequest(
            hash = hash,
            name = getStringExtra(EXTRA_NAME) ?: "Archive",
            size = getLongExtra(EXTRA_SIZE, 0),
            fileIndex = getLongExtra(EXTRA_FILE_INDEX, -1L).takeIf { it >= 0 },
        )
    }

    private class ArchiveFailure(message: String) : Exception(message)

    companion object {
        const val ACTION_START = "dev.remagnet.app.action.START_ARCHIVE"
        const val ACTION_CANCEL = "dev.remagnet.app.action.CANCEL_ARCHIVE"

        const val EXTRA_HASH = "archive-hash"
        const val EXTRA_NAME = "archive-name"
        const val EXTRA_SIZE = "archive-size"
        const val EXTRA_FILE_INDEX = "archive-file-index"

        const val NOTIFICATION_ID = 4101

        private const val CHANNEL_ID = "archive-downloads"
        private const val PROGRESS_MAX = 1000
        private const val UPDATE_INTERVAL_MS = 250L
        private const val STOP_IDLE_DELAY_MS = 3_000L
        private const val COPY_BUFFER_BYTES = 64 * 1024

        private const val REQUEST_OPEN_APP = 101
        private const val REQUEST_OPEN_ARCHIVE = 102
        private const val REQUEST_CANCEL = 103
        private const val REQUEST_RETRY = 104
        private const val REQUEST_DISMISS = 105

        /** Start a download. The caller has already claimed the single slot. */
        fun start(context: Context, request: ArchiveRequest) {
            context.startForegroundService(
                Intent(context, ArchiveDownloadService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_HASH, request.hash)
                    .putExtra(EXTRA_NAME, request.name)
                    .putExtra(EXTRA_SIZE, request.size)
                    .putExtra(EXTRA_FILE_INDEX, request.fileIndex ?: -1L),
            )
        }

        fun cancel(context: Context) {
            context.startService(
                Intent(context, ArchiveDownloadService::class.java).setAction(ACTION_CANCEL),
            )
        }
    }
}
