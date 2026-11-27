package dev.remagnet.app.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.client.TorrentFile
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.download.ArchiveDownloadState
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
        togglingHash: String? = null,
        bulkPauseBusy: Boolean = false,
        onDownload: (TorrentSummary) -> Unit = {},
        onRemove: (TorrentSummary, Boolean) -> Unit = { _, _ -> },
        onTogglePause: (TorrentSummary) -> Unit = {},
        onPauseAll: () -> Unit = {},
        onResumeAll: () -> Unit = {},
        expandedHash: String? = null,
        filesByHash: Map<String, List<TorrentFile>> = emptyMap(),
        filesLoadingHash: String? = null,
        filesError: String? = null,
        onToggleFiles: (TorrentSummary) -> Unit = {},
        onDownloadFile: (TorrentSummary, TorrentFile) -> Unit = { _, _ -> },
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
                    togglingHash = togglingHash,
                    bulkPauseBusy = bulkPauseBusy,
                    onTogglePause = onTogglePause,
                    onPauseAll = onPauseAll,
                    onResumeAll = onResumeAll,
                    expandedHash = expandedHash,
                    filesByHash = filesByHash,
                    filesLoadingHash = filesLoadingHash,
                    filesError = filesError,
                    onToggleFiles = onToggleFiles,
                    onDownloadFile = onDownloadFile,
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

        compose.onNodeWithText("Downloading 25% · 512 B/s").assertIsDisplayed()
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
    fun activeTorrentOffersPause() {
        var toggled: TorrentSummary? = null
        val downloading = torrent.copy(state = TorrentState.Downloading, progress = 0.5)
        render(
            torrents = listOf(downloading),
            onTogglePause = { toggled = it },
        )

        compose.onNodeWithText("Pause").assertIsDisplayed().performClick()

        assertEquals(downloading, toggled)
    }

    @Test
    fun stoppedTorrentOffersResume() {
        var toggled: TorrentSummary? = null
        val stopped = torrent.copy(state = TorrentState.Stopped)
        render(
            torrents = listOf(stopped),
            onTogglePause = { toggled = it },
        )

        compose.onNodeWithText("Resume").assertIsDisplayed().performClick()

        assertEquals(stopped, toggled)
    }

    @Test
    fun togglingATorrentShowsProgressAndDisablesItsButton() {
        render(
            torrents = listOf(torrent.copy(state = TorrentState.Downloading, progress = 0.5)),
            togglingHash = torrent.hash,
        )

        compose.onNodeWithText("Pausing…").assertIsDisplayed()
        compose.onNodeWithText("Pause").assertIsNotEnabled()
    }

    @Test
    fun bulkPauseIsOfferedWhenAnyTorrentIsActive() {
        var pausedAll = false
        render(
            torrents = listOf(torrent.copy(state = TorrentState.Downloading, progress = 0.5)),
            onPauseAll = { pausedAll = true },
        )

        compose.onNodeWithText("Resume all").assertDoesNotExist()
        compose.onNodeWithText("Pause all").assertIsDisplayed().performClick()

        assertEquals(true, pausedAll)
    }

    @Test
    fun bulkResumeIsOfferedWhenAnyTorrentIsStopped() {
        var resumedAll = false
        render(
            torrents = listOf(torrent.copy(state = TorrentState.Stopped)),
            onResumeAll = { resumedAll = true },
        )

        compose.onNodeWithText("Pause all").assertDoesNotExist()
        compose.onNodeWithText("Resume all").assertIsDisplayed().performClick()

        assertEquals(true, resumedAll)
    }

    @Test
    fun mixedStatesOfferBothBulkActions() {
        render(
            torrents = listOf(
                torrent.copy(state = TorrentState.Downloading, progress = 0.5),
                torrent.copy(hash = "b".repeat(40), state = TorrentState.Stopped),
            ),
        )

        compose.onNodeWithText("Pause all").assertIsDisplayed()
        compose.onNodeWithText("Resume all").assertIsDisplayed()
    }

    @Test
    fun bulkActionsDisableWhileBulkWorkRuns() {
        render(
            torrents = listOf(
                torrent.copy(state = TorrentState.Downloading, progress = 0.5),
                torrent.copy(hash = "b".repeat(40), state = TorrentState.Stopped),
            ),
            bulkPauseBusy = true,
        )

        compose.onNodeWithText("Pause all").assertIsNotEnabled()
        compose.onNodeWithText("Resume all").assertIsNotEnabled()
    }

    @Test
    fun emptyListInvitesAddingAMagnet() {
        render(torrents = emptyList())

        compose.onNodeWithText(
            "No Remagnet torrents yet. Add a magnet to see it here.",
        ).assertExists()
    }

    @Test
    fun searchingFiltersRenderedRows() {
        render(torrents = threeTorrents())

        compose.onNode(hasSetTextAction()).performTextInput("zeta")

        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("nebula.iso").assertDoesNotExist()
        compose.onNodeWithText("alpha.iso").assertDoesNotExist()

        compose.onNodeWithText("Clear").performClick()

        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("nebula.iso").assertExists()
        compose.onNodeWithText("alpha.iso").assertExists()
    }

    @Test
    fun filterTabsFilterRenderedRows() {
        render(torrents = threeTorrents())

        compose.onNodeWithText("All 3").assertIsSelected().performClick()
        compose.onNodeWithText("nebula.iso").assertExists()
        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("alpha.iso").assertExists()

        compose.onNodeWithText("Active 1").performClick().assertIsSelected()
        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("nebula.iso").assertDoesNotExist()
        compose.onNodeWithText("alpha.iso").assertDoesNotExist()

        compose.onNodeWithText("Ready 2").performClick().assertIsSelected()
        compose.onNodeWithText("nebula.iso").assertExists()
        compose.onNodeWithText("alpha.iso").assertExists()
        compose.onNodeWithText("zeta.iso").assertDoesNotExist()

        compose.onNodeWithText("Paused 1").performClick().assertIsSelected()
        compose.onNodeWithText("alpha.iso").assertExists()
        compose.onNodeWithText("nebula.iso").assertDoesNotExist()
        compose.onNodeWithText("zeta.iso").assertDoesNotExist()

        compose.onNodeWithText("All 3").performClick().assertIsSelected()
        compose.onNodeWithText("nebula.iso").assertExists()
        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("alpha.iso").assertExists()
    }

    @Test
    fun sortMenuChangesRowOrder() {
        render(torrents = threeTorrents())

        assertRowAbove("nebula.iso", "zeta.iso")
        assertRowAbove("zeta.iso", "alpha.iso")

        compose.onNodeWithText("Sort: Newest").performClick()
        compose.onNodeWithText("Name").performClick()

        compose.onNodeWithText("Sort: Name").assertExists()
        assertRowAbove("alpha.iso", "nebula.iso")
        assertRowAbove("nebula.iso", "zeta.iso")

        compose.onNodeWithText("Sort: Name").performClick()
        compose.onNodeWithText("Size").performClick()

        compose.onNodeWithText("Sort: Size").assertExists()
        assertRowAbove("nebula.iso", "zeta.iso")
        assertRowAbove("zeta.iso", "alpha.iso")
    }

    @Test
    fun emptyFilterStateResetsAndRestoresAllRows() {
        render(torrents = threeTorrents())

        compose.onNode(hasSetTextAction()).performTextInput("zeta")
        compose.onNodeWithText("Ready 2").performClick()

        compose.onNodeWithText("No torrents match your filter.").assertExists()
        compose.onNodeWithText("Reset filters").assertExists().performClick()

        compose.onNodeWithText("All 3").assertIsSelected()
        compose.onNodeWithText("nebula.iso").assertExists()
        compose.onNodeWithText("zeta.iso").assertExists()
        compose.onNodeWithText("alpha.iso").assertExists()
    }

    @Test
    fun singleTorrentHidesSearchAndFilterControls() {
        render()

        compose.onNodeWithText("Search torrents…").assertDoesNotExist()
        compose.onNodeWithText("Sort: Newest").assertDoesNotExist()
        compose.onNodeWithText("All 1").assertDoesNotExist()
    }

    @Test
    fun filesButtonTogglesTheBrowser() {
        var toggled: TorrentSummary? = null
        render(onToggleFiles = { toggled = it })

        compose.onNodeWithText("Files").assertIsDisplayed().performClick()

        assertEquals(torrent, toggled)
    }

    @Test
    fun expandedTorrentShowsLoadingWhileFilesAreFetched() {
        render(expandedHash = torrent.hash, filesLoadingHash = torrent.hash)

        compose.onNodeWithText("Hide files").assertIsDisplayed()
        compose.onNodeWithText("Loading files…").assertIsDisplayed()
    }

    @Test
    fun expandedTorrentShowsFileError() {
        render(
            expandedHash = torrent.hash,
            filesError = "The Remagnet Proxy could not read the files in that torrent.",
        )

        compose.onNodeWithText(
            "The Remagnet Proxy could not read the files in that torrent.",
        ).assertIsDisplayed()
    }

    @Test
    fun expandedTorrentWithNoFilesShowsEmptyState() {
        render(expandedHash = torrent.hash)

        compose.onNodeWithText("No files available yet.").assertIsDisplayed()
    }

    @Test
    fun fileRowsShowProgressAndOnlyCompletedFilesCanBeDownloaded() {
        val completeFile = TorrentFile(
            index = 0,
            name = "nebula/README.txt",
            size = 2048,
            progress = 1.0,
        )
        val partialFile = TorrentFile(
            index = 1,
            name = "nebula/data.iso",
            size = 3072,
            progress = 0.5,
        )
        var downloaded: Pair<TorrentSummary, TorrentFile>? = null
        val downloading = torrent.copy(state = TorrentState.Downloading, progress = 0.5)

        render(
            torrents = listOf(downloading),
            expandedHash = downloading.hash,
            filesByHash = mapOf(downloading.hash to listOf(completeFile, partialFile)),
            onDownloadFile = { item, file -> downloaded = item to file },
        )

        compose.onNodeWithText("nebula/README.txt").assertIsDisplayed()
        compose.onNodeWithText("nebula/data.iso").assertIsDisplayed()
        compose.onNodeWithText("2 KB").assertIsDisplayed()
        compose.onNodeWithText("3 KB · 50%").assertIsDisplayed()
        compose.onAllNodesWithText("Download").assertCountEquals(1)
        compose.onNodeWithText("Download").performClick()

        assertEquals(downloading to completeFile, downloaded)
    }

    private fun threeTorrents() = listOf(
        torrent.copy(
            hash = "b".repeat(40),
            name = "nebula.iso",
            state = TorrentState.Seeding,
            progress = 1.0,
            size = 400,
        ),
        torrent.copy(
            hash = "c".repeat(40),
            name = "zeta.iso",
            state = TorrentState.Downloading,
            progress = 0.5,
            size = 200,
        ),
        torrent.copy(
            hash = "d".repeat(40),
            name = "alpha.iso",
            state = TorrentState.Stopped,
            progress = 1.0,
            size = 100,
        ),
    )

    private fun assertRowAbove(first: String, second: String) {
        val firstTop = compose.onNodeWithText(first).fetchSemanticsNode().boundsInRoot.top
        val secondTop = compose.onNodeWithText(second).fetchSemanticsNode().boundsInRoot.top
        assertTrue("$first should render above $second", firstTop < secondTop)
    }
}
