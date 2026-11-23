package dev.remagnet.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette

/**
 * The saved Remagnet Proxy endpoint, its last check, and a manual retest.
 *
 * This is the app's only connection: qBittorrent is reached by the proxy, so a
 * successful check also reports the backend client and its versions.
 */
@Composable
fun ProxyPanel(
    settings: RemagnetSettings,
    status: ProxyStatus?,
    checking: Boolean,
    onTest: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Panel(modifier) {
        SectionLabel("Remagnet Proxy")
        Text(
            text = settings.proxyBaseUrl,
            color = RemagnetPalette.Muted,
            fontFamily = GeistMono,
            fontSize = 11.sp,
        )
        if (status is ProxyStatus.Online) {
            Column {
                Text(
                    text = "Backend: ${status.clientLabel.ifBlank { "qBittorrent" }}",
                    color = RemagnetPalette.Done,
                    fontFamily = GeistMono,
                    fontSize = 10.sp,
                )
                Text(
                    text = "App ${status.appVersion} · Web API ${status.webApiVersion}",
                    color = RemagnetPalette.Muted,
                    fontFamily = GeistMono,
                    fontSize = 10.sp,
                )
            }
        }
        val note = proxyNote(status, checking)
        StatusNote(text = note.text, tone = note.tone)
        PrimaryButton(
            text = if (checking) "Checking…" else "Test connection",
            onClick = onTest,
            enabled = !checking,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun proxyNote(status: ProxyStatus?, checking: Boolean): Note = when {
    checking -> Note("Checking the Remagnet Proxy and its qBittorrent connection…", StatusTone.Neutral)
    status == null -> Note("Not tested yet.", StatusTone.Neutral)
    status is ProxyStatus.Online -> Note(
        "Remagnet Proxy online. ${status.clientLabel.ifBlank { "qBittorrent" }} " +
            "${status.appVersion} (Web API ${status.webApiVersion}).",
        StatusTone.Ok,
    )

    status is ProxyStatus.Unauthorized -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.QbitUnavailable -> Note(status.message, StatusTone.Warn)
    status is ProxyStatus.Unreachable -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.Misconfigured -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.NotConfigured -> Note("Not configured.", StatusTone.Neutral)
    else -> Note("Unknown Remagnet Proxy state.", StatusTone.Neutral)
}

private data class Note(val text: String, val tone: StatusTone)
