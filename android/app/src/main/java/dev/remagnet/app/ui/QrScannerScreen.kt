package dev.remagnet.app.ui

import android.util.Log
import android.view.MotionEvent
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraControl
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.remagnet.app.scan.QrCodeDecoder
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

private const val ScannerTag = "QrScanner"

/** How long a tap-to-focus point stays locked before continuous AF resumes. */
private const val FOCUS_AUTO_CANCEL_SECONDS = 3L

/**
 * CameraX-backed QR scanner.
 *
 * The camera binding lives here; [QrScannerContent] holds everything visual so
 * Compose tests can render the screen without camera hardware.
 */
@Composable
fun QrScannerScreen(
    onScanned: (String) -> Unit,
    onClose: () -> Unit,
    onPasteCode: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onClose)

    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val decoder = remember { QrCodeDecoder() }
    val scanned = remember { AtomicBoolean(false) }
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val currentOnScanned by rememberUpdatedState(onScanned)

    // The view is created once so the preview surface survives recompositions.
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }

    var cameraError by remember { mutableStateOf<String?>(null) }
    var hasFlash by remember { mutableStateOf(false) }
    var torchEnabled by remember { mutableStateOf(false) }
    var cameraControl by remember { mutableStateOf<CameraControl?>(null) }

    // Frames arrive on the analysis executor. Claim the scan there so only one
    // frame can ever win, then deliver the result on the main thread.
    fun submit(code: String) {
        val trimmed = code.trim()
        if (trimmed.isEmpty()) return
        if (!scanned.compareAndSet(false, true)) return
        mainExecutor.execute { currentOnScanned(trimmed) }
    }

    fun toggleTorch() {
        val control = cameraControl ?: return
        val next = !torchEnabled
        control.enableTorch(next)
        torchEnabled = next
    }

    DisposableEffect(lifecycleOwner, previewView) {
        val executor = Executors.newSingleThreadExecutor()
        var disposed = false
        var analysis: ImageAnalysis? = null
        var provider: ProcessCameraProvider? = null

        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (disposed) return@addListener
            val cameraProvider = try {
                future.get()
            } catch (error: Exception) {
                Log.w(ScannerTag, "Camera provider failed", error)
                cameraError = "The camera could not start on this device."
                return@addListener
            }
            provider = cameraProvider

            val selector = when {
                cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) ->
                    CameraSelector.DEFAULT_BACK_CAMERA

                cameraProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) ->
                    CameraSelector.DEFAULT_FRONT_CAMERA

                else -> null
            }
            if (selector == null) {
                cameraError = "This device has no camera available."
                return@addListener
            }

            if (disposed) {
                cameraProvider.unbindAll()
                return@addListener
            }

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val imageAnalysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { analyzer ->
                    analyzer.setAnalyzer(executor) { image ->
                        try {
                            decoder.decodeImageProxy(image)?.let(::submit)
                        } catch (error: Exception) {
                            // A garbled frame is normal; the next one will do.
                            Log.d(ScannerTag, "Skipped an undecodable frame", error)
                        } finally {
                            image.close()
                        }
                    }
                }
            analysis = imageAnalysis

            try {
                cameraProvider.unbindAll()
                val camera = cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    selector,
                    preview,
                    imageAnalysis,
                )
                cameraControl = camera.cameraControl
                hasFlash = camera.cameraInfo.hasFlashUnit()
                torchEnabled = false
                cameraError = null
            } catch (error: Exception) {
                Log.w(ScannerTag, "Camera binding failed", error)
                cameraError = "The camera is in use or unavailable."
            }
        }, mainExecutor)

        onDispose {
            disposed = true
            analysis?.clearAnalyzer()
            runCatching { cameraControl?.enableTorch(false) }
            runCatching { provider?.unbindAll() }
            executor.shutdown()
        }
    }

    // Tap anywhere on the preview to focus and meter that spot. Continuous
    // autofocus still runs; this just nudges it at close range.
    DisposableEffect(previewView) {
        previewView.setOnTouchListener { view, event ->
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                // Tap-to-focus is this view's click action. Report it so
                // accessibility services can trigger the same path.
                view.performClick()
                val control = cameraControl
                if (control != null) {
                    val point = previewView.meteringPointFactory.createPoint(
                        event.x,
                        event.y,
                    )
                    val action = FocusMeteringAction
                        .Builder(
                            point,
                            FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE,
                        )
                        .setAutoCancelDuration(FOCUS_AUTO_CANCEL_SECONDS, TimeUnit.SECONDS)
                        .build()
                    control.startFocusAndMetering(action)
                }
            }
            true
        }
        onDispose { previewView.setOnTouchListener(null) }
    }

    QrScannerContent(
        onClose = onClose,
        onPasteCode = onPasteCode,
        modifier = modifier,
        hasFlash = hasFlash,
        torchEnabled = torchEnabled,
        onToggleFlash = ::toggleTorch,
        cameraError = cameraError,
        cameraPreview = {
            AndroidView(
                factory = { previewView },
                modifier = Modifier.fillMaxSize(),
            )
        },
    )
}

/**
 * Stateless scanner UI: a dimmed preview with a sharp scan window, plus the
 * close, torch and paste fallbacks. Kept free of CameraX so Robolectric tests
 * can drive it directly.
 */
@Composable
fun QrScannerContent(
    onClose: () -> Unit,
    onPasteCode: () -> Unit,
    modifier: Modifier = Modifier,
    hasFlash: Boolean = false,
    torchEnabled: Boolean = false,
    onToggleFlash: () -> Unit = {},
    cameraError: String? = null,
    cameraPreview: @Composable () -> Unit = {},
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(RemagnetPalette.Background),
    ) {
        if (cameraError != null) {
            CameraUnavailablePanel(
                message = cameraError,
                onPasteCode = onPasteCode,
                onClose = onClose,
            )
        } else {
            Box(Modifier.fillMaxSize()) { cameraPreview() }

            ScanWindowOverlay(Modifier.fillMaxSize())

            Column(Modifier.fillMaxSize()) {
                ScannerTopBar(
                    hasFlash = hasFlash,
                    torchEnabled = torchEnabled,
                    onToggleFlash = onToggleFlash,
                    onClose = onClose,
                )
                Spacer(Modifier.weight(1f))
                ScannerControls(onPasteCode = onPasteCode)
            }
        }
    }
}

@Composable
private fun ScannerTopBar(
    hasFlash: Boolean,
    torchEnabled: Boolean,
    onToggleFlash: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SecondaryButton(text = "Close", onClick = onClose)
        Text(
            text = "Scan code",
            modifier = Modifier.weight(1f),
            color = RemagnetPalette.Text,
            fontFamily = GeistMono,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        if (hasFlash) {
            SecondaryButton(
                text = if (torchEnabled) "Flash off" else "Flash on",
                onClick = onToggleFlash,
            )
        }
    }
}

@Composable
private fun ScannerControls(onPasteCode: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 20.dp)
            .padding(bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            text = "Point the camera at the QR code on your Remagnet Proxy page.",
            color = RemagnetPalette.Text,
            fontFamily = GeistMono,
            fontSize = 12.sp,
            lineHeight = 18.sp,
            textAlign = TextAlign.Center,
        )
        SecondaryButton(text = "Paste code instead", onClick = onPasteCode)
    }
}

/**
 * The scan window: a 62% black scrim punched through with a sharp square, a
 * hairline border and four accent brackets. There is deliberately no laser
 * sweep; the brackets are enough to anchor the eye.
 */
@Composable
private fun ScanWindowOverlay(modifier: Modifier = Modifier) {
    Canvas(
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen },
    ) {
        val side = min(size.width, size.height) * 0.68f
        val left = (size.width - side) / 2f
        val top = (size.height - side) / 2f
        val window = Rect(left, top, left + side, top + side)

        drawRect(RemagnetPalette.ScrimScanner)
        drawRect(
            color = Color.Transparent,
            topLeft = window.topLeft,
            size = window.size,
            blendMode = BlendMode.Clear,
        )
        drawRect(
            color = RemagnetPalette.Line,
            topLeft = window.topLeft,
            size = window.size,
            style = Stroke(width = 1.dp.toPx()),
        )

        val bracket = min(28.dp.toPx(), side * 0.2f)
        val stroke = 3.dp.toPx()
        val accent = RemagnetPalette.Accent

        fun bracketAt(corner: Offset, horizontal: Float, vertical: Float) {
            drawLine(
                color = accent,
                start = corner - Offset(horizontal * stroke / 2f, 0f),
                end = corner + Offset(horizontal * bracket, 0f),
                strokeWidth = stroke,
                cap = StrokeCap.Butt,
            )
            drawLine(
                color = accent,
                start = corner,
                end = corner + Offset(0f, vertical * bracket),
                strokeWidth = stroke,
                cap = StrokeCap.Butt,
            )
        }

        bracketAt(Offset(window.left, window.top), 1f, 1f)
        bracketAt(Offset(window.right, window.top), -1f, 1f)
        bracketAt(Offset(window.left, window.bottom), 1f, -1f)
        bracketAt(Offset(window.right, window.bottom), -1f, -1f)
    }
}

@Composable
private fun CameraUnavailablePanel(
    message: String,
    onPasteCode: () -> Unit,
    onClose: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Panel {
            SectionLabel("Scan code")
            Text(
                text = "Camera unavailable",
                color = RemagnetPalette.Text,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message,
                color = RemagnetPalette.Muted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )
            Spacer(Modifier.height(2.dp))
            PrimaryButton(
                text = "Paste code",
                onClick = onPasteCode,
                modifier = Modifier.fillMaxWidth(),
            )
            SecondaryButton(
                text = "Close",
                onClick = onClose,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
