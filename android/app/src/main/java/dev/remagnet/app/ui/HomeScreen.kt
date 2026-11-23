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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette

/**
 * The app's first screen is the torrent list. It is deliberately backed by
 * settings and real client calls, so an empty install never looks like a broken
 * library.
 */
@Composable
fun HomeScreen(
    state: RemagnetUiState,
    onOpenSettings: () -> Unit,
    onScanCode: () -> Unit,
    onAddMagnet: () -> Unit,
    onRefreshTorrents: () -> Unit,
    onDownload: (TorrentSummary) -> Unit,
    onCancelDownload: () -> Unit,
    onDismissDownload: () -> Unit,
    onRemoveToggle: (TorrentSummary) -> Unit,
    onRemove: (TorrentSummary, Boolean) -> Unit,
    onCancelRemove: () -> Unit,
    onOpenArchive: (String) -> Unit,
    onDismissActionError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            ScreenHeader(
                surface = "Android",
                actionText = "Settings",
                onAction = onOpenSettings,
            )
        }

        item {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Torrents",
                        color = RemagnetPalette.Text,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (state.torrents.size >= 2) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = state.torrents.size.toString(),
                            color = RemagnetPalette.Muted,
                            fontFamily = GeistMono,
                            fontSize = 11.sp,
                        )
                    }
                }
                Spacer(Modifier.height(5.dp))
                Text(
                    text = "Refreshes while this screen is open.",
                    color = RemagnetPalette.Muted,
                    fontFamily = GeistMono,
                    fontSize = 10.sp,
                    lineHeight = 15.sp,
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
            state.actionError?.let { message ->
                item {
                    Panel {
                        StatusNote(text = message, tone = StatusTone.Error)
                        SecondaryButton(
                            text = "Dismiss",
                            onClick = onDismissActionError,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            if (!state.settings.proxyConfigured) {
                item {
                    Panel {
                        SectionLabel("Get started")
                        Text(
                            text = "Connect to Remagnet Proxy",
                            color = RemagnetPalette.Text,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = "Scan the pairing code shown by your Remagnet Proxy, " +
                                "or open Settings and enter its URL and token. Your " +
                                "qBittorrent credentials stay on the proxy.",
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
                    TorrentListSection(
                        torrents = state.torrents,
                        loading = state.torrentsLoading,
                        error = state.torrentsError,
                        confirmingHash = state.confirmingHash,
                        removingHash = state.removingHash,
                        download = state.download,
                        onRetry = onRefreshTorrents,
                        onOpenSettings = onOpenSettings,
                        onDownload = onDownload,
                        onCancelDownload = onCancelDownload,
                        onDismissDownload = onDismissDownload,
                        onRemoveToggle = onRemoveToggle,
                        onRemove = onRemove,
                        onCancelRemove = onCancelRemove,
                        onOpenArchive = onOpenArchive,
                    )
                }
            }
        }

        state.notice?.let { notice ->
            item { StatusNote(text = notice, tone = StatusTone.Ok) }
        }
    }
}
