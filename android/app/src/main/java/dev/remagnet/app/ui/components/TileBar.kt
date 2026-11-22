package dev.remagnet.app.ui.components

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/** The four visual phases the extension uses for its square-cell bar. */
enum class TileBarPhase { Idle, Fetch, Zip, Done }

/** Pixel measurements for one bar. Callers scale dp values by density. */
data class TileBarOptions(
    val cell: Float = 6f,
    val gap: Float = 2f,
    val rows: Int = 3,
    val jitter: Float = 7f,
    val counter: Boolean = true,
    val counterTile: Float = 4f,
    val counterGap: Float = 1f,
    val counterSlots: Int = 3,
    val counterMargin: Float = 14f,
)

/** Deterministic geometry, cell thresholds and counter placement. */
data class TileBarLayout(
    val width: Float,
    val cell: Float,
    val gap: Float,
    val rows: Int,
    val cols: Int,
    val count: Int,
    val step: Float,
    val gridHeight: Float,
    val totalHeight: Float,
    val offsetX: Float,
    val counterCols: Int,
    val counterStep: Float,
    val counterTile: Float,
    val counterHeight: Float,
    val counterX: Float,
    val counterMargin: Float,
    val thresholds: FloatArray,
    val shadeIndex: IntArray,
    val order: IntArray,
)

/** 3x5 tile font for the inline percentage counter. */
val TILE_FONT: Map<Char, Array<String>> = mapOf(
    '0' to arrayOf("111", "101", "101", "101", "111"),
    '1' to arrayOf("010", "110", "010", "010", "111"),
    '2' to arrayOf("111", "001", "111", "100", "111"),
    '3' to arrayOf("111", "001", "111", "001", "111"),
    '4' to arrayOf("101", "101", "111", "001", "001"),
    '5' to arrayOf("111", "100", "111", "001", "111"),
    '6' to arrayOf("111", "100", "111", "101", "111"),
    '7' to arrayOf("111", "001", "001", "001", "001"),
    '8' to arrayOf("111", "101", "111", "101", "111"),
    '9' to arrayOf("111", "101", "111", "001", "111"),
)

val TILE_BAR_SHADE_FACTORS = floatArrayOf(0.82f, 0.91f, 1f)

/**
 * Same layout rules as `extension/lib/tile-bar.ts`.
 *
 * Every column gets a position between 0 and 1 with a little seeded jitter, so
 * the leading edge is ragged. Sorting those positions gives the order cells
 * fill in and keeps the animation identical on both clients.
 */
fun tileBarLayout(width: Float, options: TileBarOptions = TileBarOptions()): TileBarLayout {
    val step = options.cell + options.gap
    val gridHeight = options.rows * step - options.gap
    val counterStep = options.counterTile + options.counterGap
    val counterCols = if (options.counter) options.counterSlots * 4 - 1 else 0
    val counterHeight = if (options.counter) 5 * counterStep - options.counterGap else 0f
    val reserve = if (options.counter) {
        counterCols * counterStep - options.counterGap + options.counterMargin
    } else {
        0f
    }

    val cols = max(1, floor((width - reserve + options.gap) / step).toInt())
    val count = cols * options.rows
    val offsetX = max(0f, floor((width - (cols * step - options.gap + reserve)) / 2f))
    val counterX = offsetX + cols * step - options.gap + options.counterMargin

    val random = seededRandom(1337)
    val thresholds = FloatArray(count)
    val shadeIndex = IntArray(count)
    val span = cols - 1 + options.jitter
    for (index in 0 until count) {
        val col = index % cols
        thresholds[index] = (col + random() * options.jitter) / span
        shadeIndex[index] = floor(random() * TILE_BAR_SHADE_FACTORS.size).toInt()
    }

    val order = (0 until count).sortedBy { thresholds[it] }.toIntArray()

    return TileBarLayout(
        width = width,
        cell = options.cell,
        gap = options.gap,
        rows = options.rows,
        cols = cols,
        count = count,
        step = step,
        gridHeight = gridHeight,
        totalHeight = max(gridHeight, counterHeight),
        offsetX = offsetX,
        counterCols = counterCols,
        counterStep = counterStep,
        counterTile = options.counterTile,
        counterHeight = counterHeight,
        counterX = counterX,
        counterMargin = options.counterMargin,
        thresholds = thresholds,
        shadeIndex = shadeIndex,
        order = order,
    )
}

/**
 * Right-align "5" / "42" / "100" into the reserved glyph slots, one boolean per
 * counter tile in row-major order.
 */
fun counterBitmap(percent: Int, columns: Int, slots: Int): BooleanArray {
    val bitmap = BooleanArray(columns * 5)
    if (columns <= 0 || slots <= 0) return bitmap

    val text = percent.coerceIn(0, 100).toString().padStart(slots, ' ').takeLast(slots)
    for (slot in 0 until slots) {
        val glyph = TILE_FONT[text[slot]] ?: continue
        for (row in 0 until 5) {
            for (col in 0 until 3) {
                if (glyph[row][col] == '1') bitmap[row * columns + slot * 4 + col] = true
            }
        }
    }
    return bitmap
}

/** Small deterministic PRNG so resizing does not reshuffle the cells. */
fun seededRandom(seed: Int): () -> Float {
    var state = seed
    return {
        state += 0x6d2b79f5
        var value = (state xor (state ushr 15)) * (1 or state)
        value += (value xor (value ushr 7)) * (61 or value)
        value = value xor (value ushr 14)
        val unsigned = value.toLong() and 0xffffffffL
        (unsigned.toDouble() / 4_294_967_296.0).toFloat()
    }
}

/** Rounded height a Compose bar should reserve for a given density scale. */
fun tileBarHeight(options: TileBarOptions): Float {
    val step = options.cell + options.gap
    val gridHeight = options.rows * step - options.gap
    val counterHeight = if (options.counter) {
        5 * (options.counterTile + options.counterGap) - options.counterGap
    } else {
        0f
    }
    return ceil(max(gridHeight, counterHeight))
}

/** Top of the grid inside the reserved height, centered against the counter. */
fun gridTop(layout: TileBarLayout): Float = (layout.totalHeight - layout.gridHeight) / 2f

/** Top of the counter inside the reserved height. */
fun counterTop(layout: TileBarLayout): Float = (layout.totalHeight - layout.counterHeight) / 2f

/** Integer percent for the counter, floored so 100% waits for completion. */
fun tileBarPercent(progress: Float): Int =
    floor(progress.coerceIn(0f, 1f) * 100f + 1e-4f).toInt()
