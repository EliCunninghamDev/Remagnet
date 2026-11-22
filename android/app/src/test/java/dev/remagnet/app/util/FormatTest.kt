package dev.remagnet.app.util

import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    @Test
    fun formatsByteCountsLikeTheExtension() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("1 B", formatBytes(1))
        assertEquals("1 KB", formatBytes(1024))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("1 MB", formatBytes(1024L * 1024))
        assertEquals("100 MB", formatBytes(100L * 1024 * 1024))
        assertEquals("4 GB", formatBytes(4L * 1024 * 1024 * 1024))
        assertEquals("0 B", formatBytes(-5))
    }

    @Test
    fun formatsSpeedWithAPerSecondSuffix() {
        assertEquals("1.5 KB/s", formatSpeed(1536))
    }

    @Test
    fun formatPercentClampsAndRounds() {
        assertEquals("50%", formatPercent(0.5))
        assertEquals("100%", formatPercent(0.999))
        assertEquals("0%", formatPercent(-1.0))
        assertEquals("100%", formatPercent(2.0))
        assertEquals("0%", formatPercent(Double.NaN))
    }
}
