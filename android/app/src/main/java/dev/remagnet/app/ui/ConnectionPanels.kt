package dev.remagnet.app.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.data.AuthMode
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette

/** The saved qBittorrent endpoint, its last check, and a manual retest. */
@Composable
fun TorrentClientPanel(
    settings: RemagnetSettings,
    status: QbitStatus?,
    checking: Boolean,
    onTest: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Panel(modifier) {
        SectionLabel("Torrent client")
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "qBittorrent",
                color = RemagnetPalette.Text,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (settings.authMode == AuthMode.ApiKey) "API KEY" else "PASSWORD",
                color = RemagnetPalette.Done,
                fontFamily = GeistMono,
                fontSize = 9.sp,
                letterSpacing = 1.sp,
            )
        }
        Text(
            text = settings.qbitBaseUrl,
            color = RemagnetPalette.Muted,
            fontFamily = GeistMono,
            fontSize = 11.sp,
        )
        val note = qbitNote(status, checking)
        StatusNote(text = note.text, tone = note.tone)
        PrimaryButton(
            text = if (checking) "Checking…" else "Test qBittorrent",
            onClick = onTest,
            enabled = !checking,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** The saved Remagnet Proxy endpoint, its last check, and a manual retest. */
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
        val note = proxyNote(status, checking)
        StatusNote(text = note.text, tone = note.tone)
        PrimaryButton(
            text = if (checking) "Checking…" else "Test Remagnet Proxy",
            onClick = onTest,
            enabled = !checking,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun qbitNote(status: QbitStatus?, checking: Boolean): Note = when {
    checking -> Note("Checking qBittorrent directly…", StatusTone.Neutral)
    status == null -> Note("Not tested yet.", StatusTone.Neutral)
    status is QbitStatus.Online -> Note(
        "qBittorrent ${status.appVersion} (Web API ${status.webApiVersion}).",
        StatusTone.Ok,
    )

    status is QbitStatus.Unauthorized -> Note(status.message, StatusTone.Error)
    status is QbitStatus.Unreachable -> Note(status.message, StatusTone.Error)
    status is QbitStatus.Error -> Note(status.message, StatusTone.Error)
    status is QbitStatus.NotConfigured -> Note("Not configured.", StatusTone.Neutral)
    else -> Note("Unknown qBittorrent state.", StatusTone.Neutral)
}

private fun proxyNote(status: ProxyStatus?, checking: Boolean): Note = when {
    checking -> Note("Checking the Remagnet Proxy and its qBittorrent connection…", StatusTone.Neutral)
    status == null -> Note("Not tested yet.", StatusTone.Neutral)
    status is ProxyStatus.Online -> Note(
        "Remagnet Proxy online. qBittorrent ${status.appVersion} " +
            "(Web API ${status.webApiVersion}).",
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
