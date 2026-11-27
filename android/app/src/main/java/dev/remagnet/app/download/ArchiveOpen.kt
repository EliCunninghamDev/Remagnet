package dev.remagnet.app.download

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/** FileProvider authority, shared by the notification and the in-app action. */
fun archiveAuthority(context: Context): String = "${context.packageName}.files"

/**
 * Open a saved archive with whatever the device has, falling back to a share
 * sheet when no ZIP viewer is registered.
 */
fun openArchive(context: Context, path: String): Boolean {
    val file = File(path)
    if (!file.exists()) {
        Toast.makeText(context, "The archive is no longer there.", Toast.LENGTH_SHORT).show()
        return false
    }

    val uri = try {
        FileProvider.getUriForFile(context, archiveAuthority(context), file)
    } catch (_: IllegalArgumentException) {
        Toast.makeText(context, "The archive could not be opened.", Toast.LENGTH_SHORT).show()
        return false
    }

    val extension = file.extension.lowercase()
    val mimeType = when {
        extension == "zip" -> "application/zip"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
    }

    val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mimeType)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    return try {
        context.startActivity(view)
        true
    } catch (_: ActivityNotFoundException) {
        val share = Intent(Intent.ACTION_SEND)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            context.startActivity(
                Intent.createChooser(share, "Open archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, "No app can open this archive.", Toast.LENGTH_SHORT).show()
            false
        }
    }
}
