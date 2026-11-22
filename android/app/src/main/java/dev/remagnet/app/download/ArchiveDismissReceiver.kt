package dev.remagnet.app.download

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Dismiss a finished/failed download notification without starting a service
 * from the background. The state and the notification are cleared together.
 */
class ArchiveDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        ArchiveDownloads.dismiss()
        context.getSystemService(NotificationManager::class.java)
            ?.cancel(ArchiveDownloadService.NOTIFICATION_ID)
    }
}
