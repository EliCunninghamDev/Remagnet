package dev.remagnet.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.data.AuthMode
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette

/**
 * The app's first screen is a connection status. It is deliberately not a
 * mock torrent list: every state shown here is backed by settings or a real
 * proxy call, so an empty install never looks like a broken library.
 */
@Composable
fun HomeScreen(
    state: RemagnetUiState,
    onOpenSettings: () -> Unit,
    onScanCode: () -> Unit,
    onTestConnection: () -> Unit,
    onTestQbitConnection: () -> Unit,
    onAddMagnet: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RemagnetWordmark(surface = "Android")
                Spacer(Modifier.weight(1f))
                SecondaryButton(text = "Settings", onClick = onOpenSettings)
            }
        }

        item {
            Column {
                Text(
                    text = "Connections",
                    color = RemagnetPalette.Text,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "Remagnet sends magnets to qBittorrent. The optional " +
                        "proxy turns completed torrents into ZIP downloads.",
                    color = RemagnetPalette.Muted,
                    style = MaterialTheme.typography.bodyMedium,
                    lineHeight = 19.sp,
                )
            }
        }

        item {
            PrimaryButton(
                text = "Add magnet",
                onClick = onAddMagnet,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (!state.loaded) {
            item {
                Text(
                    text = "Loading settings…",
                    color = RemagnetPalette.Muted,
                    fontFamily = GeistMono,
                    fontSize = 12.sp,
                )
            }
        } else {
            if (!state.settings.qbitConfigured) {
                item {
                    Panel {
                        SectionLabel("Get started")
                        Text(
                            text = "Connect your torrent client",
                            color = RemagnetPalette.Text,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = "Enter the qBittorrent Web UI URL and an API key, or " +
                                "import a Remagnet connect code. qBittorrent 5.2 or newer " +
                                "supports API keys; username and password also work.",
                            color = RemagnetPalette.Muted,
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PrimaryButton(
                                text = "Open settings",
                                onClick = onOpenSettings,
                                modifier = Modifier.weight(1f),
                            )
                            SecondaryButton(
                                text = "Scan code",
                                onClick = onScanCode,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            } else {
                item {
                    TorrentClientPanel(
                        settings = state.settings,
                        status = state.qbitStatus,
                        checking = state.checkingQbit,
                        onTest = onTestQbitConnection,
                        onEdit = onOpenSettings,
                    )
                }
            }

            item {
                ProxyPanel(
                    settings = state.settings,
                    status = state.proxyStatus,
                    checking = state.checking,
                    onTest = onTestConnection,
                    onScan = onScanCode,
                    onEdit = onOpenSettings,
                )
            }
        }

        state.notice?.let { notice ->
            item { StatusNote(text = notice, tone = StatusTone.Ok) }
        }

        item {
            Text(
                text = "Credentials are encrypted on this device. The proxy token " +
                    "never leaves it in plaintext.",
                color = RemagnetPalette.Muted,
                fontFamily = GeistMono,
                fontSize = 10.sp,
                lineHeight = 15.sp,
            )
        }
    }
}

@Composable
private fun TorrentClientPanel(
    settings: RemagnetSettings,
    status: QbitStatus?,
    checking: Boolean,
    onTest: () -> Unit,
    onEdit: () -> Unit,
) {
    Panel {
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
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(
                text = if (checking) "Checking…" else "Test connection",
                onClick = onTest,
                enabled = !checking,
                modifier = Modifier.weight(1f),
            )
            SecondaryButton(
                text = "Edit",
                onClick = onEdit,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun ProxyPanel(
    settings: RemagnetSettings,
    status: ProxyStatus?,
    checking: Boolean,
    onTest: () -> Unit,
    onScan: () -> Unit,
    onEdit: () -> Unit,
) {
    Panel {
        SectionLabel("Download proxy")
        if (!settings.proxyConfigured) {
            Text(
                text = "Not configured",
                color = RemagnetPalette.Text,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Add the proxy URL and token to download completed torrents " +
                    "as ZIP files. The app still adds and manages torrents without it.",
                color = RemagnetPalette.Muted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(
                    text = "Set up proxy",
                    onClick = onEdit,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Scan code",
                    onClick = onScan,
                    modifier = Modifier.weight(1f),
                )
            }
            return@Panel
        }

        Text(
            text = settings.proxyBaseUrl,
            color = RemagnetPalette.Muted,
            fontFamily = GeistMono,
            fontSize = 11.sp,
        )
        val note = proxyNote(status, checking)
        StatusNote(text = note.text, tone = note.tone)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(
                text = if (checking) "Checking…" else "Test connection",
                onClick = onTest,
                enabled = !checking,
                modifier = Modifier.weight(1f),
            )
            SecondaryButton(
                text = "Scan code",
                onClick = onScan,
                modifier = Modifier.weight(1f),
            )
        }
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
    checking -> Note("Checking the proxy and its qBittorrent connection…", StatusTone.Neutral)
    status == null -> Note("Not tested yet.", StatusTone.Neutral)
    status is ProxyStatus.Online -> Note(
        "Proxy online. qBittorrent ${status.appVersion} (Web API ${status.webApiVersion}).",
        StatusTone.Ok,
    )

    status is ProxyStatus.Unauthorized -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.QbitUnavailable -> Note(status.message, StatusTone.Warn)
    status is ProxyStatus.Unreachable -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.Misconfigured -> Note(status.message, StatusTone.Error)
    status is ProxyStatus.NotConfigured -> Note("Not configured.", StatusTone.Neutral)
    else -> Note("Unknown proxy state.", StatusTone.Neutral)
}

private data class Note(val text: String, val tone: StatusTone)
