package dev.remagnet.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.R

/**
 * The same neutral palette the extension uses for its always-dark popover.
 * Values mirror the `color.popup` group in the repository's `tokens.js`.
 */
object RemagnetPalette {
    val Background = Color(0xFF141517)
    val Panel = Color(0xFF181A1C)
    val Line = Color(0xFF2A2D30)
    val Text = Color(0xFFCFD1D3)
    val Muted = Color(0xFF7D8286)
    val Accent = Color(0xFF70A3D2)
    val OnAccent = Color(0xFF10161B)
    val Done = Color(0xFF84BC98)
    val Warn = Color(0xFFCFA65E)
    val Track = Color(0xFF1D1F21)
    val Tile0 = Color(0xFF4A4E52)
    val Tile1 = Color(0xFF52565A)
    val Tile2 = Color(0xFF5A5E62)
    val Error = Color(0xFFD98C8C)
    val ErrorPanel = Color(0xFF2A1C1C)
    val OkPanel = Color(0xFF1B241F)
    val WarnPanel = Color(0xFF2A2418)

    /** The diagonal highlight that crosses the square bar while zipping. */
    val Sweep = Color(0xFFE4E7E9)

    /** Scrim behind the add-torrent sheet. */
    val ScrimSheet = Color.Black.copy(alpha = 0.55f)

    /** Scrim punched through by the QR scanner's scan window. */
    val ScrimScanner = Color.Black.copy(alpha = 0.62f)
}

/** Geist Mono carries the interface, as it does in the browser clients. */
val GeistMono = FontFamily(
    Font(R.font.geist_mono_regular, FontWeight.Normal),
    Font(R.font.geist_mono_semibold, FontWeight.SemiBold),
)

/** Departure Mono is reserved for the wordmark. */
val DepartureMono = FontFamily(
    Font(R.font.departure_mono, FontWeight.Normal),
)

private val RemagnetColorScheme = darkColorScheme(
    primary = RemagnetPalette.Accent,
    onPrimary = RemagnetPalette.OnAccent,
    primaryContainer = RemagnetPalette.Track,
    onPrimaryContainer = RemagnetPalette.Text,
    secondary = RemagnetPalette.Done,
    onSecondary = RemagnetPalette.OnAccent,
    tertiary = RemagnetPalette.Warn,
    onTertiary = RemagnetPalette.OnAccent,
    background = RemagnetPalette.Background,
    onBackground = RemagnetPalette.Text,
    surface = RemagnetPalette.Panel,
    onSurface = RemagnetPalette.Text,
    surfaceVariant = RemagnetPalette.Track,
    onSurfaceVariant = RemagnetPalette.Muted,
    // Material surfaces for dialogs, menus and sheets. Without these, M3 falls
    // back to its purplish-gray dark defaults under our always-dark scheme.
    surfaceContainerLowest = RemagnetPalette.Panel,
    surfaceContainerLow = RemagnetPalette.Panel,
    surfaceContainer = RemagnetPalette.Panel,
    surfaceContainerHigh = RemagnetPalette.Track,
    surfaceContainerHighest = RemagnetPalette.Track,
    outline = RemagnetPalette.Line,
    outlineVariant = RemagnetPalette.Line,
    error = RemagnetPalette.Error,
    onError = RemagnetPalette.OnAccent,
    errorContainer = RemagnetPalette.ErrorPanel,
    onErrorContainer = RemagnetPalette.Error,
)

/**
 * Remagnet uses square corners everywhere, including Material controls that
 * default to a rounded shape.
 */
private val RemagnetShapes = Shapes(
    extraSmall = RoundedCornerShape(0.dp),
    small = RoundedCornerShape(0.dp),
    medium = RoundedCornerShape(0.dp),
    large = RoundedCornerShape(0.dp),
    extraLarge = RoundedCornerShape(0.dp),
)

/**
 * Durations and easing shared by the square-bar progress animation, mirroring
 * the `motion` group in `tokens.js`.
 */
object RemagnetMotion {
    /** Tiles ease toward a new progress value over this window. */
    const val ProgressDurationMs = 460

    /** One pass of the sweep highlight while a torrent is zipping. */
    const val SweepDurationMs = 1300

    /** Ease-out cubic, matching the browser clients' progress easing. */
    val OutCubic = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)
}

private val RemagnetTypography = Typography().let { base ->
    base.copy(
        displayLarge = base.displayLarge.copy(fontFamily = GeistMono),
        displayMedium = base.displayMedium.copy(fontFamily = GeistMono),
        displaySmall = base.displaySmall.copy(fontFamily = GeistMono),
        headlineLarge = base.headlineLarge.copy(fontFamily = GeistMono),
        headlineMedium = base.headlineMedium.copy(fontFamily = GeistMono),
        headlineSmall = base.headlineSmall.copy(fontFamily = GeistMono),
        titleLarge = base.titleLarge.copy(fontFamily = GeistMono),
        titleMedium = base.titleMedium.copy(fontFamily = GeistMono),
        titleSmall = base.titleSmall.copy(fontFamily = GeistMono),
        bodyLarge = base.bodyLarge.copy(fontFamily = GeistMono),
        bodyMedium = base.bodyMedium.copy(fontFamily = GeistMono),
        bodySmall = base.bodySmall.copy(fontFamily = GeistMono),
        labelLarge = base.labelLarge.copy(fontFamily = GeistMono),
        labelMedium = base.labelMedium.copy(fontFamily = GeistMono),
        labelSmall = base.labelSmall.copy(fontFamily = GeistMono),
    )
}

@Composable
fun RemagnetTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = RemagnetColorScheme,
        typography = RemagnetTypography,
        shapes = RemagnetShapes,
        content = content,
    )
}

/** Monospace label used above sections and for status text. */
val SectionLabelSize = 10.sp
val SectionLabelSpacing = 1.2.sp
