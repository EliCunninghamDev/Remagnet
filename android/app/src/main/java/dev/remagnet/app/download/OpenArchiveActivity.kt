package dev.remagnet.app.download

import android.os.Bundle
import androidx.activity.ComponentActivity

/**
 * The target of the completion notification and in-app "Open" action.
 *
 * It exists so a missing ZIP viewer becomes a share sheet instead of a silent
 * `ActivityNotFoundException` from a notification pending intent.
 */
class OpenArchiveActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent?.getStringExtra(EXTRA_PATH)
        if (path != null) openArchive(this, path)
        finish()
    }

    companion object {
        const val EXTRA_PATH = "archive-path"
    }
}
