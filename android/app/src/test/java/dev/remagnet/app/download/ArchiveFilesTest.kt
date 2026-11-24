package dev.remagnet.app.download

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArchiveFilesTest {
    @Test
    fun makesASafeZipName() {
        assertEquals("Ubuntu 24.04.iso.zip", safeArchiveName("Ubuntu 24.04.iso"))
        // Directories are stripped, not flattened into the name.
        assertEquals("c_d.zip", safeArchiveName("a/b\\c:d"))
        assertEquals("archive.zip", safeArchiveName("   "))
        assertEquals("archive.zip", safeArchiveName("..."))
    }

    @Test
    fun doesNotDoubleTheZipSuffix() {
        assertEquals("Backup.zip", safeArchiveName("Backup.zip"))
        assertEquals("Backup.zip", safeArchiveName("Backup.ZIP"))
    }

    @Test
    fun stripsTrailingDotsAndSpaces() {
        assertEquals("Name.zip", safeArchiveName("Name... "))
    }

    @Test
    fun limitsLongNames() {
        val name = "a".repeat(300)
        val safe = safeArchiveName(name)

        assertTrue(safe.length <= 104)
        assertTrue(safe.endsWith(".zip"))
    }

    @Test
    fun picksTheNextFreeName() {
        val directory = createTempDir("archive-names")
        try {
            val first = uniqueArchiveFile(directory, "Ubuntu.zip")
            assertEquals("Ubuntu.zip", first.name)
            first.writeText("x")

            val second = uniqueArchiveFile(directory, "Ubuntu.zip")
            assertEquals("Ubuntu (2).zip", second.name)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun readsAnEncodedDispositionName() {
        assertEquals(
            "Nébula 4.2.zip",
            fileNameFromDisposition("attachment; filename*=UTF-8''N%C3%A9bula%204.2.zip"),
        )
    }

    @Test
    fun keepsAPlusInAnEncodedDispositionName() {
        assertEquals("C++ Notes.zip", fileNameFromDisposition("filename*=UTF-8''C%2B%2B%20Notes.zip"))
    }

    @Test
    fun readsAQuotedOrBareDispositionName() {
        assertEquals("ubuntu.iso.zip", fileNameFromDisposition("""attachment; filename="ubuntu.iso.zip""""))
        assertEquals("ubuntu.iso.zip", fileNameFromDisposition("attachment; filename=ubuntu.iso.zip"))
        assertNull(fileNameFromDisposition(null))
        assertNull(fileNameFromDisposition("attachment"))
    }

    @Test
    fun mapsDocumentedProxyStatusesToAdvice() {
        assertTrue(archiveErrorMessage(401).contains("token"))
        assertTrue(archiveErrorMessage(404).contains("does not have"))
        assertTrue(archiveErrorMessage(409).contains("not complete"))
        assertTrue(archiveErrorMessage(502).contains("could not reach qBittorrent"))
        assertTrue(archiveErrorMessage(500, "<html>nope</html>").contains("start the archive"))
        assertFalse(archiveErrorMessage(500, "<html>nope</html>").contains("html"))
    }

    @Test
    fun prefersTheProxyJsonErrorMessage() {
        assertEquals(
            "The proxy token expired.",
            archiveErrorMessage(401, """{"error":"The proxy token expired."}"""),
        )
        assertEquals(
            "qBittorrent is offline.",
            archiveErrorMessage(502, """{"error":"qBittorrent is offline."}"""),
        )
        assertTrue(
            archiveErrorMessage(500, """{"code":"internal_error"}""")
                .contains("start the archive"),
        )
        assertFalse(archiveErrorMessage(500, """{"code":"internal_error"}""").contains("{"))
    }

    private fun createTempDir(prefix: String): File =
        File.createTempFile(prefix, "").let { file ->
            file.delete()
            file.mkdirs()
            file
        }
}

class SpeedMeterTest {
    @Test
    fun firstSampleHasNoSpeedYet() {
        val meter = SpeedMeter(clock = { 0L })
        assertEquals(0, meter.sample(1024))
    }

    @Test
    fun computesAndSmoothsASpeed() {
        var now = 0L
        val meter = SpeedMeter(clock = { now })

        meter.sample(0)
        now += 1_000
        assertEquals(100_000, meter.sample(100_000))

        now += 1_000
        val smoothed = meter.sample(300_000)
        assertEquals(130_000, smoothed)
    }

    @Test
    fun ignoresSamplesThatAreTooCloseTogether() {
        var now = 0L
        val meter = SpeedMeter(clock = { now })

        meter.sample(0)
        now += 1_000
        meter.sample(100_000)
        now += 50
        val first = meter.sample(120_000)
        val second = meter.sample(140_000)
        assertEquals(first, second)
    }
}

class ArchiveDownloadsTest {
    @Test
    fun claimsOneSlotAndReportsProgress() {
        ArchiveDownloads.dismiss()
        assertTrue(ArchiveDownloads.claim("a", "A", 1_000))
        assertTrue(ArchiveDownloads.isActive("a"))
        assertFalse(ArchiveDownloads.claim("b", "B", 2_000))

        ArchiveDownloads.progress("a", 250, 1_000, 1_024)
        val active = ArchiveDownloads.state.value as ArchiveDownloadState.Active
        assertEquals(0.25f, active.fraction!!, 0.0001f)
        assertEquals(25, active.percent)
        assertEquals(1_024L, active.speed)

        ArchiveDownloads.complete("a", "A", "A.zip", "/tmp/A.zip", 1_000)
        assertFalse(ArchiveDownloads.isActive())
        assertTrue(ArchiveDownloads.state.value is ArchiveDownloadState.Complete)
        assertTrue(ArchiveDownloads.claim("b", "B", 2_000))
        ArchiveDownloads.dismiss()
    }

    @Test
    fun fractionsAreUnknownWithoutASize() {
        val active = ArchiveDownloadState.Active("a", "A", bytes = 10, total = 0, speed = 0)

        assertNull(active.fraction)
        assertNull(active.percent)
    }

    @Test
    fun progressForAnotherHashIsIgnored() {
        ArchiveDownloads.dismiss()
        ArchiveDownloads.claim("a", "A", 1_000)
        ArchiveDownloads.progress("b", 900, 1_000, 10)

        val active = ArchiveDownloads.state.value as ArchiveDownloadState.Active
        assertEquals(0L, active.bytes)
        ArchiveDownloads.dismiss()
    }
}
