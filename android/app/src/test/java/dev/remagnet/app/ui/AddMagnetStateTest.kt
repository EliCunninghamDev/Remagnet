package dev.remagnet.app.ui

import dev.remagnet.app.client.QbitError
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.magnet.MagnetLink
import dev.remagnet.app.magnet.TorrentFileInfo
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AddMagnetStateTest {
    private val magnet = MagnetLink(
        uri = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
        infoHash = "0123456789abcdef0123456789abcdef01234567",
        displayName = "Ubuntu",
        sizeBytes = 1024,
        trackers = emptyList(),
    )

    private val torrentFile = TorrentFileInfo(
        filename = "ubuntu.torrent",
        infoHash = "b".repeat(40),
        displayName = "Ubuntu 24.04",
        sizeBytes = 5L * 1024 * 1024,
        fileCount = 3,
        trackers = listOf("udp://tracker.example:1337/announce"),
        webSeeds = listOf("https://seed.example/ubuntu.iso"),
        isPrivate = true,
    )

    @Test
    fun aMissingTorrentIsClear() {
        assertEquals(
            DuplicateState.Clear,
            duplicateStateFor(QbitResult.Success(null)),
        )
    }

    @Test
    fun anExistingTorrentBlocksTheAdd() {
        val torrent = torrent()

        val duplicate = duplicateStateFor(QbitResult.Success(torrent))

        assertTrue(duplicate is DuplicateState.Existing)
        assertEquals(torrent, (duplicate as DuplicateState.Existing).torrent)
    }

    @Test
    fun aFailedLookupKeepsItsMessage() {
        val duplicate = duplicateStateFor(
            QbitResult.Failure(QbitError.Unreachable("Could not reach qBittorrent.")),
        )

        assertEquals(
            DuplicateState.Failed("Could not reach qBittorrent."),
            duplicate,
        )
    }

    @Test
    fun submitIsBlockedWhileCheckingAndForADuplicate() {
        assertFalse(review(DuplicateState.Checking).canSubmit)
        assertFalse(review(DuplicateState.Existing(torrent())).canSubmit)
        assertFalse(review(DuplicateState.NotConfigured).canSubmit)
        assertTrue(review(DuplicateState.Clear).canSubmit)
    }

    @Test
    fun aFailedLookupStillAllowsTheAttempt() {
        assertTrue(review(DuplicateState.Failed("offline")).canSubmit)
    }

    @Test
    fun submitIsBlockedWhileASendIsRunning() {
        assertFalse(review(DuplicateState.Clear, submitting = true).canSubmit)
    }

    @Test
    fun aMagnetItemExposesTheMagnetFields() {
        val item = AddItem.Magnet(magnet)

        assertEquals(magnet.uri, item.key)
        assertEquals(magnet.infoHash, item.infoHash)
        assertEquals("Ubuntu", item.label)
        assertEquals(magnet.sizeBytes, item.sizeBytes)
        assertEquals(magnet.trackers, item.trackers)
        assertEquals(magnet.webSeeds, item.webSeeds)
        assertNull(item.fileCount)
        assertFalse(item.isPrivate)
    }

    @Test
    fun aTorrentFileItemExposesTheParsedFileFields() {
        val item = AddItem.TorrentFile(torrentFile, stagedPath = "/tmp/staged.torrent")

        assertEquals("/tmp/staged.torrent", item.key)
        assertEquals(torrentFile.infoHash, item.infoHash)
        assertEquals("Ubuntu 24.04", item.label)
        assertEquals(torrentFile.sizeBytes, item.sizeBytes)
        assertEquals(3, item.fileCount)
        assertEquals(torrentFile.trackers, item.trackers)
        assertEquals(torrentFile.webSeeds, item.webSeeds)
        assertTrue(item.isPrivate)
    }

    @Test
    fun aTorrentFileItemFallsBackToAFilenameLabel() {
        val unnamed = torrentFile.copy(displayName = null, filename = "release.torrent")

        assertEquals("release", AddItem.TorrentFile(unnamed, "/tmp/x.torrent").label)
    }

    @Test
    fun theAddRequestCarriesTheMagnetAndPausedFlag() {
        val request = addRequestFor(magnet, paused = true)

        assertEquals(listOf(magnet.uri), request.urls)
        assertTrue(request.files.isEmpty())
        assertTrue(request.paused)
    }

    @Test
    fun theAddRequestNeverIncludesCategoryOrTags() {
        // The proxy applies its own configured defaults; the phone must not
        // send values it cannot see.
        val request = addRequestFor(magnet, paused = false)

        assertFalse(request.paused)
        assertEquals(listOf(magnet.uri), request.urls)
    }

    @Test
    fun theFileAddRequestCarriesTheBytesAndPausedFlag() {
        val bytes = byteArrayOf(0x64, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f, 0x65)

        val request = addRequestFor(torrentFile, bytes, paused = true)

        assertTrue(request.urls.isEmpty())
        assertEquals(1, request.files.size)
        assertEquals("ubuntu.torrent", request.files.single().filename)
        assertArrayEquals(bytes, request.files.single().bytes)
        assertTrue(request.paused)
    }

    private fun review(
        duplicate: DuplicateState,
        submitting: Boolean = false,
    ) = AddSheetState.Review(
        item = AddItem.Magnet(magnet),
        duplicate = duplicate,
        submitting = submitting,
    )

    private fun torrent() = TorrentSummary(
        hash = magnet.infoHash!!,
        name = "Ubuntu ISO",
        state = TorrentState.Seeding,
        rawState = "stalledUP",
        progress = 1.0,
        size = 4_294_967_296,
        downloadSpeed = 0,
        uploadSpeed = 2048,
        eta = 8_640_000,
        ratio = 1.5,
        category = "remagnet",
        tags = listOf("remagnet"),
        seeds = 3,
        peers = 4,
        addedOn = 1_700_000_000,
    )
}
