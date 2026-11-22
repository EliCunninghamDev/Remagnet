package dev.remagnet.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    @Test
    fun formatsRemainingTime() {
        assertEquals("—", formatEta(0))
        assertEquals("—", formatEta(ETA_UNKNOWN_SECONDS))
        assertEquals("45s", formatEta(45))
        assertEquals("3m", formatEta(3 * 60))
        assertEquals("2h 5m", formatEta(2 * 3600 + 5 * 60))
        assertEquals("1d 2h", formatEta(26 * 3600))
    }

    @Test
    fun leavesShortTorrentNamesWhole() {
        val name = "Ubuntu 24.04.iso"
        assertEquals(NameSplit(name, ""), splitTorrentName(name))
    }

    @Test
    fun splitsLongNamesAtABoundaryNearTheEnd() {
        val name = "nebula-4.2-amd64-netinst-2026-11-22.iso"
        val split = splitTorrentName(name)

        assertTrue(split.head.isNotEmpty())
        assertTrue(split.tail.isNotEmpty())
        assertEquals(name, split.head + split.tail)
        assertTrue(split.tail.endsWith(".iso"))
        assertTrue(split.tail.contains("2026"))
    }

    @Test
    fun splitsNamesWithoutASeparator() {
        val name = "a".repeat(60)
        val split = splitTorrentName(name)

        assertEquals(44, split.head.length)
        assertEquals(16, split.tail.length)
        assertEquals(name, split.head + split.tail)
    }
}
