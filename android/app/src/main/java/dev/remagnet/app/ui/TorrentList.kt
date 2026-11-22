package dev.remagnet.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.client.torrentFilterDescription
import dev.remagnet.app.client.torrentFilterFor
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.download.ArchiveDownloadState
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SquareBar
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.components.TileBarPhase
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import dev.remagnet.app.util.formatBytes
import dev.remagnet.app.util.formatEta
import dev.remagnet.app.util.formatSpeed
import dev.remagnet.app.util.splitTorrentName

/**
 * The homepage torrent list. Every state is explicit: loading, an unreachable
 * client, an empty client, an empty filtered list and the rows themselves.
 */
@Composable
fun TorrentListSection(
    settings: RemagnetSettings,
    torrents: List<TorrentSummary>,
    loading: Boolean,
    error: String?,
    confirmingHash: String?,
    removingHash: String?,
    download: ArchiveDownloadState,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
    onDownload: (TorrentSummary) -> Unit,
    onCancelDownload: () -> Unit,
    onDismissDownload: () -> Unit,
    onRemoveToggle: (TorrentSummary) -> Unit,
    onRemove: (TorrentSummary, Boolean) -> Unit,
    onCancelRemove: () -> Unit,
    onOpenArchive: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val filter = torrentFilterFor(settings)

    Panel(modifier) {
        when {
            error != null && torrents.isEmpty() -> {
                StatusNote(text = error, tone = StatusTone.Error)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(
                        text = if (loading) "Retrying…" else "Retry",
                        onClick = onRetry,
                        enabled = !loading,
                        modifier = Modifier.weight(1f),
                    )
                    SecondaryButton(
                        text = "Settings",
                        onClick = onOpenSettings,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            loading && torrents.isEmpty() -> Text(
                text = "Loading torrents…",
                color = RemagnetPalette.Muted,
                fontFamily = GeistMono,
                fontSize = 12.sp,
            )

            torrents.isEmpty() -> {
                Text(
                    text = if (filter.active) {
                        "No Remagnet torrents yet. Add a magnet to see it here; matching " +
                            "uses ${torrentFilterDescription(filter)}."
                    } else {
                        "No torrents in qBittorrent."
                    },
                    color = RemagnetPalette.Muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
                if (filter.active) {
                    SecondaryButton(
                        text = "Open settings",
                        onClick = onOpenSettings,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            else -> {
                if (error != null) {
                    StatusNote(text = error, tone = StatusTone.Warn)
                    SecondaryButton(
                        text = "Retry",
                        onClick = onRetry,
                        enabled = !loading,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                torrents.forEachIndexed { index, torrent ->
                    if (index > 0) HorizontalDivider(color = RemagnetPalette.Line)
                    TorrentRow(
                        torrent = torrent,
                        archiveReady = settings.archiveReady,
                        download = download.forHash(torrent.hash),
                        confirming = confirmingHash == torrent.hash,
                        removing = removingHash == torrent.hash,
                        anyRemoving = removingHash != null,
                        onDownload = { onDownload(torrent) },
                        onCancelDownload = onCancelDownload,
                        onDismissDownload = onDismissDownload,
                        onRemoveToggle = { onRemoveToggle(torrent) },
                        onRemove = { deleteFiles -> onRemove(torrent, deleteFiles) },
                        onCancelRemove = onCancelRemove,
                        onOpenArchive = onOpenArchive,
                    )
                }
            }
        }
    }
}

@Composable
private fun TorrentRow(
    torrent: TorrentSummary,
    archiveReady: Boolean,
    download: ArchiveDownloadState?,
    confirming: Boolean,
    removing: Boolean,
    anyRemoving: Boolean,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onDismissDownload: () -> Unit,
    onRemoveToggle: () -> Unit,
    onRemove: (Boolean) -> Unit,
    onCancelRemove: () -> Unit,
    onOpenArchive: (String) -> Unit,
) {
    val activeDownload = download as? ArchiveDownloadState.Active
    val complete = torrent.isComplete
    val phase = when {
        activeDownload != null -> TileBarPhase.Zip
        complete -> TileBarPhase.Done
        torrent.state == TorrentState.Downloading ||
            torrent.state == TorrentState.Metadata ||
            torrent.state == TorrentState.Checking ||
            torrent.state == TorrentState.Moving -> TileBarPhase.Fetch
        torrent.state == TorrentState.Stalled -> TileBarPhase.Zip
        else -> TileBarPhase.Idle
    }
    val name = splitTorrentName(torrent.name)

    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = name.head,
                color = RemagnetPalette.Text,
                fontFamily = GeistMono,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Clip,
                modifier = Modifier.weight(1f),
            )
            if (name.tail.isNotEmpty()) {
                Text(
                    text = name.tail,
                    color = RemagnetPalette.Text,
                    fontFamily = GeistMono,
                    fontSize = 12.sp,
                    maxLines = 1,
                )
            }
        }

        Spacer(Modifier.height(8.dp))
        SquareBar(progress = torrent.progress.toFloat(), phase = phase)
        Spacer(Modifier.height(7.dp))

        Text(
            text = statsLine(torrent),
            color = RemagnetPalette.Muted,
            fontFamily = GeistMono,
            fontSize = 10.sp,
            lineHeight = 15.sp,
        )

        if (download is ArchiveDownloadState.Active) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = buildString {
                    append("Downloading ZIP")
                    download.percent?.let { append(" $it%") }
                    if (download.speed > 0) {
                        append(" · ")
                        append(formatSpeed(download.speed))
                    }
                },
                color = RemagnetPalette.Accent,
                fontFamily = GeistMono,
                fontSize = 10.sp,
            )
        }

        if (download is ArchiveDownloadState.Complete) {
            Spacer(Modifier.height(8.dp))
            StatusNote(text = "Saved ${download.fileName}", tone = StatusTone.Ok)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(
                    text = "Open",
                    onClick = { onOpenArchive(download.path) },
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Dismiss",
                    onClick = onDismissDownload,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (download is ArchiveDownloadState.Failed) {
            Spacer(Modifier.height(8.dp))
            StatusNote(text = download.message, tone = StatusTone.Error)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(
                    text = "Retry",
                    onClick = onDownload,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Dismiss",
                    onClick = onDismissDownload,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (download is ArchiveDownloadState.Cancelled) {
            Spacer(Modifier.height(8.dp))
            StatusNote(text = "Download cancelled.", tone = StatusTone.Warn)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(
                    text = "Retry",
                    onClick = onDownload,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Dismiss",
                    onClick = onDismissDownload,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (confirming) {
            Spacer(Modifier.height(10.dp))
            Text(
                text = "Remove from qBittorrent?",
                color = RemagnetPalette.Text,
                fontFamily = GeistMono,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SecondaryButton(
                    text = "Keep files",
                    onClick = { onRemove(false) },
                    enabled = !removing,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Delete files",
                    onClick = { onRemove(true) },
                    enabled = !removing,
                    danger = true,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    text = "Cancel",
                    onClick = onCancelRemove,
                    enabled = !removing,
                    modifier = Modifier.weight(1f),
                )
            }
        } else {
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = rowNote(torrent, activeDownload, removing),
                    color = noteColor(torrent, activeDownload),
                    fontFamily = GeistMono,
                    fontSize = 10.sp,
                    modifier = Modifier.weight(1f),
                )

                if (download is ArchiveDownloadState.Active) {
                    SecondaryButton(
                        text = "Cancel",
                        onClick = onCancelDownload,
                    )
                } else if (complete && archiveReady &&
                    download !is ArchiveDownloadState.Complete &&
                    download !is ArchiveDownloadState.Failed &&
                    download !is ArchiveDownloadState.Cancelled
                ) {
                    SecondaryButton(
                        text = "Download",
                        onClick = onDownload,
                    )
                }

                if (download !is ArchiveDownloadState.Active) {
                    SecondaryButton(
                        text = "Remove",
                        onClick = onRemoveToggle,
                        enabled = !removing && !anyRemoving,
                    )
                }
            }
        }
    }
}

private fun statsLine(torrent: TorrentSummary): String {
    val parts = buildList {
        add("↓ ${formatSpeed(torrent.downloadSpeed)}")
        val eta = formatEta(torrent.eta)
        if (eta != "—") add("ETA $eta")
        if (torrent.uploadSpeed > 0) add("↑ ${formatSpeed(torrent.uploadSpeed)}")
        add(
            "${formatBytes((torrent.progress * torrent.size).toLong())} / " +
                formatBytes(torrent.size),
        )
        add("${torrent.peers}/${torrent.seeds} peers")
    }
    return parts.joinToString(" · ")
}

private fun rowNote(
    torrent: TorrentSummary,
    download: ArchiveDownloadState.Active?,
    removing: Boolean,
): String {
    if (removing) return "Removing…"
    if (download != null) return "Archive download"
    if (torrent.isComplete) return "Ready"
    return when (torrent.state) {
        TorrentState.Stalled -> "Stalled"
        TorrentState.Stopped -> "Paused"
        TorrentState.Error -> "Error"
        TorrentState.MissingFiles -> "Missing files"
        TorrentState.Queued -> "Queued"
        else -> ""
    }
}

private fun noteColor(
    torrent: TorrentSummary,
    download: ArchiveDownloadState.Active?,
): androidx.compose.ui.graphics.Color = when {
    download != null -> RemagnetPalette.Accent
    torrent.isComplete -> RemagnetPalette.Done
    torrent.state == TorrentState.Stalled -> RemagnetPalette.Warn
    torrent.state == TorrentState.Error || torrent.state == TorrentState.MissingFiles ->
        RemagnetPalette.Error
    else -> RemagnetPalette.Muted
}

private fun ArchiveDownloadState.forHash(hash: String): ArchiveDownloadState? = when (this) {
    ArchiveDownloadState.Idle -> null
    is ArchiveDownloadState.Active -> takeIf { this.hash == hash }
    is ArchiveDownloadState.Complete -> takeIf { this.hash == hash }
    is ArchiveDownloadState.Failed -> takeIf { this.hash == hash }
    is ArchiveDownloadState.Cancelled -> takeIf { this.hash == hash }
}
