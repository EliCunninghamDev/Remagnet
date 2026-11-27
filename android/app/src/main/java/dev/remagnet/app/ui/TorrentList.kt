package dev.remagnet.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.TorrentFilter
import dev.remagnet.app.client.TorrentFile
import dev.remagnet.app.client.TorrentSort
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.client.countTorrentFilters
import dev.remagnet.app.client.filterAndSortTorrents
import dev.remagnet.app.download.ArchiveDownloadState
import dev.remagnet.app.ui.components.AdaptiveButtonRow
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.RemagnetTextFieldColors
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SquareBar
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.components.TextAction
import dev.remagnet.app.ui.components.TileBarPhase
import dev.remagnet.app.ui.components.isLargeText
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import dev.remagnet.app.util.IssueReportContext
import dev.remagnet.app.util.formatBytes
import dev.remagnet.app.util.formatEta
import dev.remagnet.app.util.formatPercent
import dev.remagnet.app.util.formatSpeed
import dev.remagnet.app.util.splitTorrentName

/**
 * The homepage torrent list. Every state is explicit: loading, an unreachable
 * proxy, an empty list and the rows themselves. The proxy applies its own
 * category/tag filter before responding, so the app renders the result as-is.
 */
@Composable
fun TorrentListSection(
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
    onReportIssue: (IssueReportContext) -> Unit = {},
    togglingHash: String? = null,
    bulkPauseBusy: Boolean = false,
    onTogglePause: (TorrentSummary) -> Unit = {},
    onPauseAll: () -> Unit = {},
    onResumeAll: () -> Unit = {},
    expandedHash: String? = null,
    filesByHash: Map<String, List<TorrentFile>> = emptyMap(),
    filesLoadingHash: String? = null,
    filesError: String? = null,
    onToggleFiles: (TorrentSummary) -> Unit = {},
    onDownloadFile: (TorrentSummary, TorrentFile) -> Unit = { _, _ -> },
    modifier: Modifier = Modifier,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(TorrentFilter.All) }
    var sort by rememberSaveable { mutableStateOf(TorrentSort.Added) }
    var sortMenuOpen by remember { mutableStateOf(false) }

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
                TextAction(
                    text = "Report issue",
                    onClick = {
                        onReportIssue(
                            IssueReportContext(action = "Torrent list", message = error),
                        )
                    },
                )
            }

            loading && torrents.isEmpty() -> Text(
                text = "Loading torrents…",
                color = RemagnetPalette.Muted,
                fontFamily = GeistMono,
                fontSize = 12.sp,
            )

            torrents.isEmpty() -> Text(
                text = "No Remagnet torrents yet. Add a magnet to see it here.",
                color = RemagnetPalette.Muted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )

            else -> {
                val filterCounts = remember(torrents) { countTorrentFilters(torrents) }
                val visibleTorrents = remember(torrents, query, filter, sort) {
                    filterAndSortTorrents(torrents, query, filter, sort)
                }
                val showControls =
                    torrents.size >= 2 || query.isNotBlank() || filter != TorrentFilter.All

                if (showControls) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = {
                            Text(
                                text = "Search torrents…",
                                fontFamily = GeistMono,
                                fontSize = 11.sp,
                                color = RemagnetPalette.Muted,
                            )
                        },
                        singleLine = true,
                        shape = RectangleShape,
                        colors = RemagnetTextFieldColors(),
                        textStyle = MaterialTheme.typography.bodyMedium.copy(
                            fontFamily = GeistMono,
                            fontSize = 12.sp,
                            color = RemagnetPalette.Text,
                        ),
                        trailingIcon = if (query.isNotBlank()) {
                            {
                                TextAction(
                                    text = "Clear",
                                    onClick = { query = "" },
                                )
                            }
                        } else {
                            null
                        },
                    )

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        TorrentFilter.entries.forEach { item ->
                            val count = filterCounts[item] ?: 0
                            val selected = filter == item
                            Box(
                                modifier = Modifier
                                    .border(
                                        width = 1.dp,
                                        color = if (selected) {
                                            RemagnetPalette.Accent
                                        } else {
                                            RemagnetPalette.Line
                                        },
                                        shape = RectangleShape,
                                    )
                                    .selectable(
                                        selected = selected,
                                        role = Role.Tab,
                                        onClick = { filter = item },
                                    )
                                    .padding(horizontal = 8.dp, vertical = 6.dp),
                            ) {
                                Text(
                                    text = if (count > 0) {
                                        "${item.label} $count"
                                    } else {
                                        item.label
                                    },
                                    color = if (selected) {
                                        RemagnetPalette.Text
                                    } else {
                                        RemagnetPalette.Muted
                                    },
                                    fontFamily = GeistMono,
                                    fontSize = 10.sp,
                                )
                            }
                        }
                    }

                    Box(Modifier.fillMaxWidth()) {
                        SecondaryButton(
                            text = "Sort: ${sort.label}",
                            onClick = { sortMenuOpen = true },
                        )
                        DropdownMenu(
                            expanded = sortMenuOpen,
                            onDismissRequest = { sortMenuOpen = false },
                        ) {
                            TorrentSort.entries.forEach { item ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = item.label,
                                            fontFamily = GeistMono,
                                        )
                                    },
                                    onClick = {
                                        sort = item
                                        sortMenuOpen = false
                                    },
                                )
                            }
                        }
                    }

                    HorizontalDivider(color = RemagnetPalette.Line)
                }

                if (error != null) {
                    StatusNote(text = error, tone = StatusTone.Warn)
                    SecondaryButton(
                        text = "Retry",
                        onClick = onRetry,
                        enabled = !loading,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    TextAction(
                        text = "Report issue",
                        onClick = {
                            onReportIssue(
                                IssueReportContext(action = "Torrent list", message = error),
                            )
                        },
                    )
                }

                val hasActive = torrents.any { it.state != TorrentState.Stopped }
                val hasPaused = torrents.any { it.state == TorrentState.Stopped }
                if (hasActive || hasPaused) {
                    AdaptiveButtonRow(spacing = 8.dp) {
                        if (hasActive) {
                            SecondaryButton(
                                text = "Pause all",
                                onClick = onPauseAll,
                                enabled = !bulkPauseBusy && togglingHash == null,
                                modifier = Modifier.buttonSlot(),
                            )
                        }
                        if (hasPaused) {
                            SecondaryButton(
                                text = "Resume all",
                                onClick = onResumeAll,
                                enabled = !bulkPauseBusy && togglingHash == null,
                                modifier = Modifier.buttonSlot(),
                            )
                        }
                    }
                    HorizontalDivider(color = RemagnetPalette.Line)
                }

                if (visibleTorrents.isEmpty()) {
                    Text(
                        text = "No torrents match your filter.",
                        color = RemagnetPalette.Muted,
                        fontSize = 12.sp,
                    )
                    SecondaryButton(
                        text = "Reset filters",
                        onClick = {
                            query = ""
                            filter = TorrentFilter.All
                        },
                    )
                } else {
                    visibleTorrents.forEachIndexed { index, torrent ->
                        if (index > 0) HorizontalDivider(color = RemagnetPalette.Line)
                        TorrentRow(
                            torrent = torrent,
                            download = download.forHash(torrent.hash),
                            confirming = confirmingHash == torrent.hash,
                            removing = removingHash == torrent.hash,
                            anyRemoving = removingHash != null,
                            togglingPause = togglingHash == torrent.hash,
                            anyToggling = togglingHash != null || bulkPauseBusy,
                            onDownload = { onDownload(torrent) },
                            onCancelDownload = onCancelDownload,
                            onDismissDownload = onDismissDownload,
                            onRemoveToggle = { onRemoveToggle(torrent) },
                            onRemove = { deleteFiles -> onRemove(torrent, deleteFiles) },
                            onCancelRemove = onCancelRemove,
                            onOpenArchive = onOpenArchive,
                            onTogglePause = { onTogglePause(torrent) },
                            filesOpen = expandedHash == torrent.hash,
                            files = filesByHash[torrent.hash],
                            filesLoading = filesLoadingHash == torrent.hash,
                            filesError = if (expandedHash == torrent.hash) filesError else null,
                            onToggleFiles = { onToggleFiles(torrent) },
                            onDownloadFile = { file -> onDownloadFile(torrent, file) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TorrentRow(
    torrent: TorrentSummary,
    download: ArchiveDownloadState?,
    confirming: Boolean,
    removing: Boolean,
    anyRemoving: Boolean,
    togglingPause: Boolean,
    anyToggling: Boolean,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onDismissDownload: () -> Unit,
    onRemoveToggle: () -> Unit,
    onRemove: (Boolean) -> Unit,
    onCancelRemove: () -> Unit,
    onOpenArchive: (String) -> Unit,
    onTogglePause: () -> Unit,
    filesOpen: Boolean,
    files: List<TorrentFile>?,
    filesLoading: Boolean,
    filesError: String?,
    onToggleFiles: () -> Unit,
    onDownloadFile: (TorrentFile) -> Unit,
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
        if (isLargeText()) {
            // At 2x text the fixed head/tail split cannot fit, so show the
            // whole name and let it use two lines.
            Text(
                text = torrent.name,
                color = RemagnetPalette.Text,
                fontFamily = GeistMono,
                fontSize = 12.5.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = name.head,
                    color = RemagnetPalette.Text,
                    fontFamily = GeistMono,
                    fontSize = 12.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                    modifier = Modifier.weight(1f),
                )
                if (name.tail.isNotEmpty()) {
                    Text(
                        text = name.tail,
                        color = RemagnetPalette.Text,
                        fontFamily = GeistMono,
                        fontSize = 12.5.sp,
                        maxLines = 1,
                    )
                }
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
                    append("Downloading")
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
            AdaptiveButtonRow(spacing = 6.dp) {
                SecondaryButton(
                    text = "Keep files",
                    onClick = { onRemove(false) },
                    enabled = !removing,
                    modifier = Modifier.buttonSlot(),
                )
                SecondaryButton(
                    text = "Delete files",
                    onClick = { onRemove(true) },
                    enabled = !removing,
                    danger = true,
                    modifier = Modifier.buttonSlot(),
                )
                SecondaryButton(
                    text = "Cancel",
                    onClick = onCancelRemove,
                    enabled = !removing,
                    modifier = Modifier.buttonSlot(),
                )
            }
        } else {
            Spacer(Modifier.height(8.dp))
            Text(
                text = rowNote(torrent, activeDownload, removing, togglingPause),
                color = noteColor(torrent, activeDownload),
                fontFamily = GeistMono,
                fontSize = 10.sp,
            )
            Spacer(Modifier.height(6.dp))
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                DownloadButton(
                    torrent = torrent,
                    download = download,
                    onDownload = onDownload,
                    onCancelDownload = onCancelDownload,
                )
                if (download !is ArchiveDownloadState.Active) {
                    SecondaryButton(
                        text = if (filesOpen) "Hide files" else "Files",
                        onClick = onToggleFiles,
                        enabled = !removing,
                    )
                    SecondaryButton(
                        text = if (torrent.state == TorrentState.Stopped) {
                            "Resume"
                        } else {
                            "Pause"
                        },
                        onClick = onTogglePause,
                        enabled = !togglingPause && !anyToggling && !removing,
                    )
                    SecondaryButton(
                        text = "Remove",
                        onClick = onRemoveToggle,
                        enabled = !removing && !anyRemoving,
                    )
                }
            }

            if (filesOpen) {
                Spacer(Modifier.height(8.dp))
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, RemagnetPalette.Line)
                        .background(RemagnetPalette.Background)
                        .padding(10.dp),
                ) {
                    when {
                        filesLoading -> Text(
                            text = "Loading files…",
                            color = RemagnetPalette.Muted,
                            fontFamily = GeistMono,
                            fontSize = 11.sp,
                        )

                        filesError != null -> StatusNote(
                            text = filesError,
                            tone = StatusTone.Error,
                        )

                        files.isNullOrEmpty() -> Text(
                            text = "No files available yet.",
                            color = RemagnetPalette.Muted,
                            fontFamily = GeistMono,
                            fontSize = 11.sp,
                        )

                        else -> files.forEachIndexed { index, file ->
                            if (index > 0) HorizontalDivider(color = RemagnetPalette.Line)
                            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                                Text(
                                    text = file.name,
                                    color = RemagnetPalette.Text,
                                    fontFamily = GeistMono,
                                    fontSize = 11.sp,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Text(
                                        text = buildString {
                                            append(formatBytes(file.size))
                                            if (!file.isComplete) {
                                                append(" · ")
                                                append(formatPercent(file.progress))
                                            }
                                        },
                                        color = RemagnetPalette.Muted,
                                        fontFamily = GeistMono,
                                        fontSize = 10.sp,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (file.isComplete &&
                                        download !is ArchiveDownloadState.Active
                                    ) {
                                        SecondaryButton(
                                            text = "Download",
                                            onClick = { onDownloadFile(file) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The Cancel/Download control that depends on this torrent's archive state.
 *
 * Torrents only arrive through a configured proxy, so a completed torrent can
 * always be downloaded; there is no separate "configure it first" state.
 */
@Composable
private fun DownloadButton(
    torrent: TorrentSummary,
    download: ArchiveDownloadState?,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (download is ArchiveDownloadState.Active) {
        SecondaryButton(
            text = "Cancel",
            onClick = onCancelDownload,
            modifier = modifier,
        )
    } else if (torrent.isComplete &&
        download !is ArchiveDownloadState.Complete &&
        download !is ArchiveDownloadState.Failed &&
        download !is ArchiveDownloadState.Cancelled
    ) {
        SecondaryButton(
            text = "Download",
            onClick = onDownload,
            modifier = modifier,
        )
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
    togglingPause: Boolean,
): String {
    if (removing) return "Removing…"
    if (togglingPause) {
        return if (torrent.state == TorrentState.Stopped) "Resuming…" else "Pausing…"
    }
    if (download != null) return "Downloading"
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
