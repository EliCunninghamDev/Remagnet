package dev.remagnet.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

private enum class Screen { Home, Settings }

@Composable
fun RemagnetApp(viewModel: RemagnetViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var screen by rememberSaveable { mutableStateOf(Screen.Home) }
    var scanResult by rememberSaveable { mutableStateOf<String?>(null) }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrBlank()) {
            // The settings form is where a code is reviewed before saving, so a
            // scan from Home moves there without saving anything on its own.
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

    when (screen) {
        Screen.Home -> HomeScreen(
            state = state,
            onOpenSettings = {
                viewModel.clearNotice()
                screen = Screen.Settings
            },
            onScanCode = ::startScan,
            onTestConnection = viewModel::checkConnection,
            onTestQbitConnection = viewModel::checkQbitConnection,
        )

        Screen.Settings -> SettingsScreen(
            saved = state.settings,
            scanResult = scanResult,
            onScanResultConsumed = { scanResult = null },
            onScanCode = ::startScan,
            onBack = {
                viewModel.clearNotice()
                screen = Screen.Home
            },
            onSave = viewModel::save,
        )
    }
}

private fun scanOptions(): ScanOptions = ScanOptions().apply {
    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
    setPrompt("Scan a Remagnet connect code")
    setBeepEnabled(false)
    setOrientationLocked(false)
}
