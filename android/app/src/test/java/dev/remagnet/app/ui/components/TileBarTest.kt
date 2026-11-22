package dev.remagnet.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TileBarTest {
    @Test
    fun laysOutTheSameGridAsTheExtension() {
        val layout = tileBarLayout(width = 300f)

        assertEquals(29, layout.cols)
        assertEquals(87, layout.count)
        assertEquals(1f, layout.offsetX, 0.001f)
        assertEquals(11, layout.counterCols)
        assertEquals(22f, layout.gridHeight, 0.001f)
        assertEquals(24f, layout.totalHeight, 0.001f)
        assertEquals(245f, layout.counterX, 0.001f)
        assertEquals(87, layout.order.size)
    }

    @Test
    fun thresholdsAndShadesAreDeterministic() {
        val first = tileBarLayout(width = 320f)
        val second = tileBarLayout(width = 320f)

        assertTrue(first.thresholds.contentEquals(second.thresholds))
        assertTrue(first.shadeIndex.contentEquals(second.shadeIndex))
        assertTrue(first.order.contentEquals(second.order))
        assertTrue(first.thresholds.all { it in 0f..1.2f })
        assertTrue(first.shadeIndex.all { it in 0 until TILE_BAR_SHADE_FACTORS.size })
    }

    @Test
    fun orderIsSortedByThreshold() {
        val layout = tileBarLayout(width = 360f)
        val thresholds = layout.order.map { layout.thresholds[it] }

        assertEquals(thresholds.sorted(), thresholds)
    }

    @Test
    fun narrowWidthsStillProduceOneColumn() {
        val layout = tileBarLayout(width = 40f)

        assertTrue(layout.cols >= 1)
        assertTrue(layout.count >= 3)
        assertEquals(0f, layout.offsetX, 0.001f)
    }

    @Test
    fun counterRightAlignsOneDigit() {
        val bitmap = counterBitmap(percent = 5, columns = 11, slots = 3)

        // The first two glyph slots stay empty; the 3x5 "5" sits at columns 8-10.
        assertTrue(bitmap[0 * 11 + 8])
        assertTrue(bitmap[0 * 11 + 9])
        assertTrue(bitmap[0 * 11 + 10])
        assertTrue(bitmap[1 * 11 + 8])
        assertTrue(!bitmap[1 * 11 + 9])
    }

    @Test
    fun counterRendersOneHundredInEverySlot() {
        val bitmap = counterBitmap(percent = 100, columns = 11, slots = 3)

        // "1" starts with a center pixel, "0" fills its top row.
        assertTrue(bitmap[0 * 11 + 1])
        assertTrue(bitmap[0 * 11 + 4])
        assertTrue(bitmap[0 * 11 + 5])
        assertTrue(bitmap[0 * 11 + 6])
        assertTrue(bitmap[0 * 11 + 8])
        assertTrue(bitmap[0 * 11 + 9])
        assertTrue(bitmap[0 * 11 + 10])
    }

    @Test
    fun counterClampsOutOfRangeValues() {
        assertEquals(counterBitmap(0, 11, 3).toList(), counterBitmap(-5, 11, 3).toList())
        assertEquals(counterBitmap(100, 11, 3).toList(), counterBitmap(140, 11, 3).toList())
    }

    @Test
    fun percentFloorsSoHundredWaitsForCompletion() {
        assertEquals(0, tileBarPercent(0f))
        assertEquals(42, tileBarPercent(0.425f))
        assertEquals(99, tileBarPercent(0.999f))
        assertEquals(100, tileBarPercent(1f))
    }

    @Test
    fun barHeightCoversTheCounter() {
        assertEquals(24f, tileBarHeight(TileBarOptions()), 0.001f)
        assertEquals(22f, tileBarHeight(TileBarOptions(counter = false)), 0.001f)
    }
}
