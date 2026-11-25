package dev.remagnet.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.remagnet.app.ui.theme.RemagnetMotion
import dev.remagnet.app.ui.theme.RemagnetPalette

/** Colors for one phase, using the same shade factors as the extension. */
fun tileBarColors(phase: TileBarPhase): List<Color> {
    if (phase == TileBarPhase.Idle) {
        return listOf(RemagnetPalette.Tile0, RemagnetPalette.Tile1, RemagnetPalette.Tile2)
    }

    val base = when (phase) {
        TileBarPhase.Fetch -> RemagnetPalette.Accent
        TileBarPhase.Zip -> RemagnetPalette.Warn
        TileBarPhase.Done -> RemagnetPalette.Done
        TileBarPhase.Idle -> RemagnetPalette.Tile2
    }
    return TILE_BAR_SHADE_FACTORS.map { factor ->
        Color(base.red * factor, base.green * factor, base.blue * factor)
    }
}

/**
 * The square-cell progress bar shared by every torrent row.
 *
 * The browser component draws on a canvas with a tile percentage readout. This
 * port keeps the same geometry, shade order and counter font, and animates a
 * progress change rather than replaying the fill from zero when a poll lands.
 */
@Composable
fun SquareBar(
    progress: Float,
    phase: TileBarPhase,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val options = remember(density) {
        with(density) {
            TileBarOptions(
                cell = 6.dp.toPx(),
                gap = 2.dp.toPx(),
                counterTile = 4.dp.toPx(),
                counterGap = 1.dp.toPx(),
                counterMargin = 14.dp.toPx(),
            )
        }
    }
    val barHeight = with(density) { tileBarHeight(options).toDp() }
    val displayed by animateFloatAsState(
        targetValue = progress.coerceIn(0f, 1f),
        animationSpec = tween(
            durationMillis = RemagnetMotion.ProgressDurationMs,
            easing = RemagnetMotion.OutCubic,
        ),
        label = "tile-bar-progress",
    )
    val colors = remember(phase) { tileBarColors(phase) }
    val counterColor = when (phase) {
        TileBarPhase.Fetch -> RemagnetPalette.Accent
        TileBarPhase.Zip -> RemagnetPalette.Warn
        TileBarPhase.Done -> RemagnetPalette.Done
        TileBarPhase.Idle -> RemagnetPalette.Text
    }
    val sweepPosition = if (phase == TileBarPhase.Zip) {
        val transition = rememberInfiniteTransition(label = "tile-bar-sweep")
        val position by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(
                    durationMillis = RemagnetMotion.SweepDurationMs,
                    easing = LinearEasing,
                ),
            ),
            label = "tile-bar-sweep-position",
        )
        position
    } else {
        0f
    }

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(barHeight)
            .semantics {
                progressBarRangeInfo = ProgressBarRangeInfo(
                    current = progress.coerceIn(0f, 1f),
                    range = 0f..1f,
                )
            },
    ) {
        val layout = tileBarLayout(size.width, options)
        val top = gridTop(layout)
        val counterY = counterTop(layout)
        val cell = options.cell

        for (index in 0 until layout.count) {
            drawRect(
                color = RemagnetPalette.Track,
                topLeft = Offset(
                    x = layout.offsetX + (index % layout.cols) * layout.step,
                    y = top + (index / layout.cols) * layout.step,
                ),
                size = Size(cell, cell),
            )
        }

        for (index in layout.order) {
            if (layout.thresholds[index] > displayed) break
            drawRect(
                color = colors[layout.shadeIndex[index] % colors.size],
                topLeft = Offset(
                    x = layout.offsetX + (index % layout.cols) * layout.step,
                    y = top + (index / layout.cols) * layout.step,
                ),
                size = Size(cell, cell),
            )
        }

        if (phase == TileBarPhase.Zip) {
            val gridWidth = layout.cols * layout.step - layout.gap
            clipRect(
                left = layout.offsetX,
                top = top,
                right = layout.offsetX + gridWidth,
                bottom = top + layout.gridHeight,
            ) {
                drawRect(
                    color = RemagnetPalette.Sweep.copy(alpha = 0.11f),
                    topLeft = Offset(
                        x = layout.offsetX + gridWidth * sweepPosition - cell,
                        y = top,
                    ),
                    size = Size(cell * 2.5f, layout.gridHeight),
                )
            }
        }

        if (layout.counterCols > 0) {
            for (index in 0 until layout.counterCols * 5) {
                drawRect(
                    color = RemagnetPalette.Track,
                    topLeft = Offset(
                        x = layout.counterX + (index % layout.counterCols) * layout.counterStep,
                        y = counterY + (index / layout.counterCols) * layout.counterStep,
                    ),
                    size = Size(options.counterTile, options.counterTile),
                )
            }

            val bitmap = counterBitmap(tileBarPercent(displayed), layout.counterCols, options.counterSlots)
            for (index in bitmap.indices) {
                if (!bitmap[index]) continue
                drawRect(
                    color = counterColor,
                    topLeft = Offset(
                        x = layout.counterX + (index % layout.counterCols) * layout.counterStep,
                        y = counterY + (index / layout.counterCols) * layout.counterStep,
                    ),
                    size = Size(options.counterTile, options.counterTile),
                )
            }
        }
    }
}
