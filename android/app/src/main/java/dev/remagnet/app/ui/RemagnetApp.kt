package dev.remagnet.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.download.openArchive

private enum class Screen { Home, Settings }

@Composable
fun RemagnetApp(viewModel: RemagnetViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var screen by rememberSaveable { mutableStateOf(Screen.Home) }
    var scanResult by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingDownload by remember { mutableStateOf<TorrentSummary?>(null) }

    // A magnet can arrive from another app while Settings is open. The sheet
    // belongs over Home, so bring that screen back before it appears.
    LaunchedEffect(state.addSheet) {
        if (state.addSheet !is AddSheetState.Closed) screen = Screen.Home
    }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrBlank()) {
            // Settings owns code handling: pairing saves immediately, while a
            // connect link fills the form for review.
            screen = Screen.Settings
            scanResult = contents
        }
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            scanLauncher.launch(scanOptions())
        } else {
            Toast.makeText(
                context,
                "Camera access is needed to scan a code. Use Paste code instead.",
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    fun startScan() {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) scanLauncher.launch(scanOptions()) else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    // The download service works without the notification permission, but the
    // live progress is only visible in the drawer when it is granted.
    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        pendingDownload?.let(viewModel::downloadTorrent)
        pendingDownload = null
    }

    fun startDownload(torrent: TorrentSummary) {
        val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        if (needsPermission) {
            pendingDownload = torrent
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            viewModel.downloadTorrent(torrent)
        }
    }

    if (screen == Screen.Home) {
        LifecycleResumeEffect(Unit) {
            viewModel.startPolling()
            onPauseOrDispose { viewModel.stopPolling() }
        }
    }

    when (screen) {
        Screen.Home -> HomeScreen(
            state = state,
            onOpenSettings = {
                viewModel.clearNotice()
                screen = Screen.Settings
            },
            onScanCode = ::startScan,
            onAddMagnet = viewModel::openAddSheet,
            onRefreshTorrents = viewModel::refreshTorrents,
            onDownload = ::startDownload,
            onCancelDownload = viewModel::cancelDownload,
            onDismissDownload = viewModel::dismissDownload,
            onRemoveToggle = { torrent -> viewModel.toggleRemove(torrent.hash) },
            onRemove = viewModel::removeTorrent,
            onCancelRemove = viewModel::cancelRemove,
            onOpenArchive = { path -> openArchive(context, path) },
            onDismissActionError = viewModel::dismissActionError,
        )

        Screen.Settings -> SettingsScreen(
            saved = state.settings,
            scanResult = scanResult,
            onScanResultConsumed = { scanResult = null },
            pairing = state.pairing,
            onScanPairing = viewModel::pairDevice,
            onPairingConsumed = viewModel::clearPairing,
            onScanCode = ::startScan,
            onBack = {
                viewModel.clearNotice()
                screen = Screen.Home
            },
            onSave = viewModel::save,
            proxyStatus = state.proxyStatus,
            checkingProxy = state.checkingProxy,
            onTestConnection = viewModel::testConnection,
        )
    }

    if (state.addSheet !is AddSheetState.Closed) {
        AddMagnetSheet(
            state = state.addSheet,
            settings = state.settings,
            onDismiss = viewModel::closeAddSheet,
            onDraftChange = viewModel::updateDraft,
            onReview = viewModel::reviewDraft,
            onPausedChange = viewModel::setPaused,
            onSubmit = viewModel::submitMagnet,
            onRetryDuplicate = viewModel::retryDuplicateCheck,
            onEdit = viewModel::editReviewedMagnet,
            onAddAnother = viewModel::addAnother,
            onOpenSettings = {
                viewModel.closeAddSheet()
                screen = Screen.Settings
            },
        )
    }
}

private fun scanOptions(): ScanOptions = ScanOptions().apply {
    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
    setPrompt("Scan a Remagnet connect or pairing code")
    setBeepEnabled(false)
    setOrientationLocked(false)
}
