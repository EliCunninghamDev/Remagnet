package dev.remagnet.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.download.ArchiveDownloadState
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Compose UI tests for the torrent list. They run on the JVM through
 * Robolectric, so the normal unit-test task covers them and CI needs no
 * emulator.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class TorrentListUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val torrent = TorrentSummary(
        hash = "a".repeat(40),
        name = "nebula-4.2-amd64-netinst.iso",
        state = TorrentState.Seeding,
        rawState = "stalledUP",
        progress = 1.0,
        size = 4L * 1024 * 1024,
        downloadSpeed = 0,
        uploadSpeed = 0,
        eta = 0,
        ratio = 1.0,
        category = "remagnet",
        tags = listOf("remagnet"),
        seeds = 0,
        peers = 1,
        addedOn = 0,
    )

    private fun render(
        torrents: List<TorrentSummary> = listOf(torrent),
        confirmingHash: String? = null,
        removingHash: String? = null,
        download: ArchiveDownloadState = ArchiveDownloadState.Idle,
        error: String? = null,
        onDownload: (TorrentSummary) -> Unit = {},
        onRemove: (TorrentSummary, Boolean) -> Unit = { _, _ -> },
    ) {
        compose.setContent {
            RemagnetTheme {
                TorrentListSection(
                    torrents = torrents,
                    loading = false,
                    error = error,
                    confirmingHash = confirmingHash,
                    removingHash = removingHash,
                    download = download,
                    onRetry = {},
                    onOpenSettings = {},
                    onDownload = onDownload,
                    onCancelDownload = {},
                    onDismissDownload = {},
                    onRemoveToggle = {},
                    onRemove = onRemove,
                    onCancelRemove = {},
                    onOpenArchive = {},
                )
            }
        }
    }

    @Test
    fun completeTorrentOffersDownload() {
        var downloaded: TorrentSummary? = null
        render(onDownload = { downloaded = it })

        compose.onNodeWithText("Ready").assertIsDisplayed()
        compose.onNodeWithText("Download").assertIsDisplayed().performClick()

        assertEquals(torrent, downloaded)
    }

    @Test
    fun incompleteTorrentHasNoDownloadButton() {
        render(torrents = listOf(torrent.copy(state = TorrentState.Downloading, progress = 0.5)))

        compose.onNodeWithText("Download").assertDoesNotExist()
    }

    @Test
    fun removalConfirmationReportsFileChoice() {
        var choice: Boolean? = null
        render(
            confirmingHash = torrent.hash,
            onRemove = { _, deleteFiles -> choice = deleteFiles },
        )

        compose.onNodeWithText("Remove from qBittorrent?").assertIsDisplayed()
        compose.onNodeWithText("Keep files").performClick()
        assertEquals(false, choice)

        compose.onNodeWithText("Delete files").performClick()
        assertEquals(true, choice)
    }

    @Test
    fun activeDownloadShowsCancelInsteadOfDownload() {
        render(
            download = ArchiveDownloadState.Active(
                hash = torrent.hash,
                name = torrent.name,
                bytes = 1024,
                total = 4096,
                speed = 512,
            ),
        )

        compose.onNodeWithText("Downloading ZIP 25% · 512 B/s").assertIsDisplayed()
        compose.onNodeWithText("Cancel").assertIsDisplayed()
        compose.onNodeWithText("Download").assertDoesNotExist()
    }

    @Test
    fun completedArchiveOffersOpen() {
        render(
            download = ArchiveDownloadState.Complete(
                hash = torrent.hash,
                name = torrent.name,
                fileName = "nebula.iso.zip",
                path = "/tmp/nebula.iso.zip",
                bytes = 4096,
            ),
        )

        compose.onNodeWithText("Saved nebula.iso.zip").assertIsDisplayed()
        compose.onNodeWithText("Open").assertIsDisplayed()
    }

    @Test
    fun stalledRowExplainsItsState() {
        render(torrents = listOf(torrent.copy(state = TorrentState.Stalled, progress = 0.5)))

        compose.onNodeWithText("Stalled").assertIsDisplayed()
    }

    @Test
    fun failedRefreshKeepsRowsAndOffersRetry() {
        render(error = "Could not reach qBittorrent.")

        compose.onNodeWithText("Could not reach qBittorrent.").assertIsDisplayed()
        compose.onNodeWithText("Retry").assertIsDisplayed()
        compose.onNodeWithText("nebula-4.2-amd64-netinst.iso").assertIsDisplayed()
    }

    @Test
    fun removalButtonsDisableWhileAnotherRemovalRuns() {
        render(removingHash = "b".repeat(40))

        compose.onNodeWithText("Remove").assertIsNotEnabled()
    }

    @Test
    fun emptyListInvitesAddingAMagnet() {
        render(torrents = emptyList())

        compose.onNodeWithText(
            "No Remagnet torrents yet. Add a magnet to see it here.",
        ).assertExists()
    }
}
