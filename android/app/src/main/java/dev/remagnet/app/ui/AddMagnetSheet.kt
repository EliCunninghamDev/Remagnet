package dev.remagnet.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.magnet.trackerHosts
import dev.remagnet.app.ui.components.AdaptiveButtonRow
import dev.remagnet.app.ui.components.CheckRow
import dev.remagnet.app.ui.components.Field
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.components.TextAction
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import dev.remagnet.app.util.IssueReportContext
import dev.remagnet.app.util.formatBytes
import dev.remagnet.app.util.formatPercent

/**
 * The torrent review and add flow, presented as a modal sheet over the home
 * screen. The list behind it stays visible, and dismissing never discards a
 * link that the client rejected.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddMagnetSheet(
    state: AddSheetState,
    settings: RemagnetSettings,
    onDismiss: () -> Unit,
    onDraftChange: (String) -> Unit,
    onReview: () -> Unit,
    onPausedChange: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    onRetryDuplicate: () -> Unit,
    onEdit: () -> Unit,
    onAddAnother: () -> Unit,
    onOpenSettings: () -> Unit,
    onReportIssue: (IssueReportContext) -> Unit = {},
    onPickTorrentFile: () -> Unit = {},
) {
    val submitting = state is AddSheetState.Review && state.submitting
    val submittingNow by rememberUpdatedState(submitting)
    val sheetState = rememberBottomSheetState(
        initialValue = SheetValue.Hidden,
        enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded),
        confirmValueChange = { value ->
            value != SheetValue.Hidden || !submittingNow
        },
    )

    ModalBottomSheet(
        onDismissRequest = { if (!submitting) onDismiss() },
        sheetState = sheetState,
        containerColor = RemagnetPalette.Panel,
        contentColor = RemagnetPalette.Text,
        scrimColor = RemagnetPalette.ScrimSheet,
        shape = RectangleShape,
        tonalElevation = 0.dp,
        dragHandle = {
            Box(
                Modifier
                    .padding(top = 10.dp, bottom = 14.dp)
                    .size(width = 36.dp, height = 3.dp)
                    .background(RemagnetPalette.Line),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .navigationBarsPadding()
                .padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (state) {
                is AddSheetState.Paste -> PasteContent(
                    state = state,
                    settings = settings,
                    onDraftChange = onDraftChange,
                    onReview = onReview,
                    onPickTorrentFile = onPickTorrentFile,
                    onDismiss = onDismiss,
                    onOpenSettings = onOpenSettings,
                    onReportIssue = onReportIssue,
                )

                is AddSheetState.Review -> ReviewContent(
                    state = state,
                    onPausedChange = onPausedChange,
                    onSubmit = onSubmit,
                    onRetryDuplicate = onRetryDuplicate,
                    onEdit = onEdit,
                    onDismiss = onDismiss,
                    onOpenSettings = onOpenSettings,
                    onReportIssue = onReportIssue,
                )

                is AddSheetState.Added -> AddedContent(
                    state = state,
                    onAddAnother = onAddAnother,
                    onDismiss = onDismiss,
                )

                AddSheetState.Closed -> Unit
            }
        }
    }
}

@Composable
private fun PasteContent(
    state: AddSheetState.Paste,
    settings: RemagnetSettings,
    onDraftChange: (String) -> Unit,
    onReview: () -> Unit,
    onPickTorrentFile: () -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit,
    onReportIssue: (IssueReportContext) -> Unit,
) {
    SectionLabel("Add torrent")
    Text(
        text = "Paste a magnet link, choose a .torrent file, or open or share one " +
            "from another app. Remagnet opens this sheet and sends nothing until " +
            "you confirm.",
        color = RemagnetPalette.Muted,
        fontSize = 12.sp,
        lineHeight = 18.sp,
    )
    Field(
        label = "Magnet link",
        value = state.draft,
        onValueChange = onDraftChange,
        placeholder = "magnet:?xt=urn:btih:…",
        error = state.error,
        maxLines = 4,
    )
    state.error?.let { message ->
        TextAction(
            text = "Report issue",
            onClick = {
                onReportIssue(
                    IssueReportContext(action = "Add magnet paste", message = message),
                )
            },
        )
    }
    SecondaryButton(
        text = "Choose .torrent file",
        onClick = onPickTorrentFile,
        modifier = Modifier.fillMaxWidth(),
    )
    AdaptiveButtonRow {
        PrimaryButton(
            text = "Review",
            onClick = onReview,
            enabled = state.draft.isNotBlank(),
            modifier = Modifier.buttonSlot(),
        )
        SecondaryButton(
            text = "Cancel",
            onClick = onDismiss,
            modifier = Modifier.buttonSlot(),
        )
    }
    if (!settings.proxyConfigured) {
        StatusNote(
            text = "Remagnet Proxy is not configured yet. You can review the link now " +
                "and send it after pairing or saving settings.",
            tone = StatusTone.Warn,
        )
        SecondaryButton(
            text = "Open settings",
            onClick = onOpenSettings,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ReviewContent(
    state: AddSheetState.Review,
    onPausedChange: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    onRetryDuplicate: () -> Unit,
    onEdit: () -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit,
    onReportIssue: (IssueReportContext) -> Unit,
) {
    val item = state.item
    val editLabel = when (item) {
        is AddItem.Magnet -> "Edit"
        is AddItem.TorrentFile -> "Change"
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            SectionLabel("Review")
            Text(
                text = item.label,
                color = RemagnetPalette.Text,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 21.sp,
            )
        }
        SecondaryButton(
            text = editLabel,
            onClick = onEdit,
            enabled = !state.submitting,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item.infoHash?.let { MetadataRow("Info hash", it, mono = true) }
        item.sizeBytes?.let { MetadataRow("Size", formatBytes(it)) }
        item.fileCount?.takeIf { it > 1 }?.let { count ->
            MetadataRow("Files", "$count files")
        }
        if (item.isPrivate) MetadataRow("Private", "Yes")
        if (item.trackers.isNotEmpty()) {
            val hosts = trackerHosts(item.trackers)
            MetadataRow(
                label = "Trackers (${item.trackers.size})",
                value = hosts.joinToString(", ").ifEmpty { "No readable tracker host" },
            )
        }
        if (item.webSeeds.isNotEmpty()) {
            MetadataRow("Web seeds", item.webSeeds.size.toString())
        }
    }

    DuplicateNotice(
        duplicate = state.duplicate,
        onRetry = onRetryDuplicate,
        onOpenSettings = onOpenSettings,
        onReportIssue = onReportIssue,
    )

    CheckRow(
        label = "Add paused",
        help = "Starts stopped in qBittorrent. Start it there when you are ready.",
        checked = state.paused,
        onCheckedChange = onPausedChange,
        enabled = !state.submitting,
    )

    state.error?.let { message ->
        StatusNote(text = message, tone = StatusTone.Error)
        TextAction(
            text = "Report issue",
            onClick = {
                onReportIssue(
                    IssueReportContext(action = "Add magnet", message = message),
                )
            },
        )
    }

    val sendLabel = when {
        state.submitting -> "Sending…"
        state.duplicate is DuplicateState.Checking -> "Checking…"
        else -> "Send to qBittorrent"
    }
    AdaptiveButtonRow {
        PrimaryButton(
            text = sendLabel,
            onClick = onSubmit,
            enabled = state.canSubmit,
            modifier = Modifier.buttonSlot(1.6f),
        )
        SecondaryButton(
            text = "Cancel",
            onClick = onDismiss,
            enabled = !state.submitting,
            modifier = Modifier.buttonSlot(),
        )
    }
}

@Composable
private fun DuplicateNotice(
    duplicate: DuplicateState,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
    onReportIssue: (IssueReportContext) -> Unit,
) {
    when (duplicate) {
        DuplicateState.Checking -> StatusNote(
            text = "Checking qBittorrent through Remagnet Proxy…",
            tone = StatusTone.Neutral,
        )

        DuplicateState.Clear -> StatusNote(
            text = "Not in qBittorrent yet.",
            tone = StatusTone.Neutral,
        )

        is DuplicateState.Existing -> StatusNote(
            text = "Already in qBittorrent: ${duplicate.torrent.name} (" +
                "${duplicate.torrent.state.label} · " +
                "${formatPercent(duplicate.torrent.progress)}).",
            tone = StatusTone.Warn,
        )

        is DuplicateState.Failed -> {
            StatusNote(
                text = "Could not check for duplicates. ${duplicate.message}",
                tone = StatusTone.Warn,
            )
            SecondaryButton(
                text = "Retry check",
                onClick = onRetry,
                modifier = Modifier.fillMaxWidth(),
            )
            TextAction(
                text = "Report issue",
                onClick = {
                    onReportIssue(
                        IssueReportContext(
                            action = "Duplicate check",
                            message = duplicate.message,
                        ),
                    )
                },
            )
        }

        DuplicateState.NotConfigured -> {
            StatusNote(
                text = "Remagnet Proxy is not configured. Pair this phone or enter " +
                    "the proxy URL and token in Settings before sending.",
                tone = StatusTone.Warn,
            )
            SecondaryButton(
                text = "Open settings",
                onClick = onOpenSettings,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun AddedContent(
    state: AddSheetState.Added,
    onAddAnother: () -> Unit,
    onDismiss: () -> Unit,
) {
    SectionLabel("Sent")
    Text(
        text = state.name,
        color = RemagnetPalette.Text,
        fontSize = 16.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 21.sp,
    )
    StatusNote("Remagnet Proxy sent the torrent to qBittorrent.", StatusTone.Ok)
    if (state.category.isNotEmpty()) MetadataRow("Category", state.category)
    if (state.tags.isNotEmpty()) MetadataRow("Tags", state.tags.joinToString(", "))

    AdaptiveButtonRow {
        PrimaryButton(
            text = "Add another",
            onClick = onAddAnother,
            modifier = Modifier.buttonSlot(),
        )
        SecondaryButton(
            text = "Done",
            onClick = onDismiss,
            modifier = Modifier.buttonSlot(),
        )
    }
}

@Composable
private fun MetadataRow(
    label: String,
    value: String,
    mono: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        SectionLabel(label)
        Text(
            text = value,
            color = RemagnetPalette.Text,
            fontFamily = if (mono) GeistMono else null,
            fontSize = if (mono) 10.sp else 12.sp,
            lineHeight = 16.sp,
        )
    }
}
