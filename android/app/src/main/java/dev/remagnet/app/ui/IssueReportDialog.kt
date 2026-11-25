package dev.remagnet.app.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.BuildConfig
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import dev.remagnet.app.util.IssueReportContext
import dev.remagnet.app.util.buildIssueReport

private const val PRIVACY_NOTICE =
    "Nothing is sent automatically. Review the redacted diagnostics below before " +
        "choosing how to report."

private val DiagnosticsMaxHeight = 190.dp

/**
 * The opt-in issue report dialog.
 *
 * The report is assembled on the device and nothing leaves it until the user
 * taps one of the three explicit actions. All three are ordinary Android
 * intents or a clipboard write, so Remagnet itself never opens a network
 * connection for a bug report.
 */
@Composable
fun IssueReportDialog(
    context: IssueReportContext?,
    backend: String?,
    onDismiss: () -> Unit,
) {
    val appContext = LocalContext.current
    val reportContext = remember(context, backend) {
        when {
            context == null -> IssueReportContext(
                backend = backend?.takeIf { it.isNotBlank() },
            )

            context.backend.isNullOrBlank() && !backend.isNullOrBlank() ->
                context.copy(backend = backend)

            else -> context
        }
    }
    val payload = remember(reportContext) {
        buildIssueReport(
            version = BuildConfig.VERSION_NAME,
            androidRelease = Build.VERSION.RELEASE,
            apiLevel = Build.VERSION.SDK_INT,
            deviceModel = Build.MODEL,
            context = reportContext,
        )
    }
    var copied by remember(payload.diagnostics) { mutableStateOf(false) }

    fun copyDiagnostics() {
        runCatching {
            val clipboard = appContext.getSystemService(ClipboardManager::class.java)
            clipboard?.setPrimaryClip(
                ClipData.newPlainText("Remagnet diagnostics", payload.diagnostics),
            )
        }
        copied = true
        Toast.makeText(appContext, "Diagnostics copied.", Toast.LENGTH_SHORT).show()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "Report an issue",
                color = RemagnetPalette.Text,
                fontFamily = GeistMono,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = PRIVACY_NOTICE,
                    color = RemagnetPalette.Muted,
                    fontFamily = GeistMono,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                )
                Text(
                    text = payload.diagnostics,
                    color = RemagnetPalette.Text,
                    fontFamily = GeistMono,
                    fontSize = 10.sp,
                    lineHeight = 15.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = DiagnosticsMaxHeight)
                        .background(RemagnetPalette.Track)
                        .border(1.dp, RemagnetPalette.Line)
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                )
                PrimaryButton(
                    text = "Open on GitHub",
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(payload.githubUrl))
                        runCatching {
                            launchExternal(appContext, intent)
                        }.onFailure {
                            Toast.makeText(
                                appContext,
                                "No browser found. Copy diagnostics instead.",
                                Toast.LENGTH_LONG,
                            ).show()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                SecondaryButton(
                    text = "Email report",
                    onClick = {
                        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse(payload.mailtoUrl))
                        runCatching {
                            launchExternal(appContext, intent)
                        }.onFailure {
                            Toast.makeText(
                                appContext,
                                "No email app found. Copy diagnostics instead.",
                                Toast.LENGTH_LONG,
                            ).show()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                SecondaryButton(
                    text = if (copied) "Copied" else "Copy diagnostics",
                    onClick = ::copyDiagnostics,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onDismiss,
                shape = RectangleShape,
            ) {
                Text(
                    text = "Close",
                    color = RemagnetPalette.Accent,
                    fontFamily = GeistMono,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        containerColor = RemagnetPalette.Panel,
        titleContentColor = RemagnetPalette.Text,
        textContentColor = RemagnetPalette.Text,
        shape = RectangleShape,
    )
}

/** Dialogs can be composed over a non-Activity context in tests and previews. */
private fun launchExternal(context: Context, intent: Intent) {
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
