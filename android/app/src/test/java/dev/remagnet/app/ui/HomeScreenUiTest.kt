package dev.remagnet.app.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Compose UI tests for the first screen and its two onboarding states. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class HomeScreenUiTest {
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
        state: RemagnetUiState,
        onAddMagnet: () -> Unit = {},
        onDismissActionError: () -> Unit = {},
        onOpenSettings: () -> Unit = {},
    ) {
        compose.setContent {
            RemagnetTheme {
                HomeScreen(
                    state = state,
                    onOpenSettings = onOpenSettings,
                    onScanCode = {},
                    onAddMagnet = onAddMagnet,
                    onRefreshTorrents = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onDismissDownload = {},
                    onRemoveToggle = {},
                    onRemove = { _, _ -> },
                    onCancelRemove = {},
                    onOpenArchive = {},
                    onDismissActionError = onDismissActionError,
                )
            }
        }
    }

    @Test
    fun firstRunOffersSettingsAndScanCode() {
        render(RemagnetUiState(loaded = true))

        compose.onNodeWithText("Connect to Remagnet Proxy").assertIsDisplayed()
        compose.onNodeWithText("Open settings").assertIsDisplayed()
        compose.onAllNodesWithText("Scan code").assertCountEquals(1)
    }

    @Test
    fun configuredHomeShowsTorrentsWithoutConnectionSettings() {
        val settings = RemagnetSettings(
            proxyBaseUrl = "https://proxy.example",
            proxyToken = "test-token-12345",
        )
        render(
            RemagnetUiState(
                settings = settings,
                loaded = true,
                torrents = listOf(torrent),
            ),
        )

        compose.onNodeWithText("nebula-4.2-amd64-netinst.iso").assertIsDisplayed()
        compose.onAllNodesWithText("Torrent client").assertCountEquals(0)
        compose.onAllNodesWithText("Remagnet Proxy").assertCountEquals(0)
        compose.onAllNodesWithText("Credentials are encrypted on this device. The proxy token " +
            "never leaves it in plaintext.").assertCountEquals(0)
    }

    @Test
    fun addTorrentActionOpensTheSheet() {
        var opened = false
        render(RemagnetUiState(loaded = true), onAddMagnet = { opened = true })

        compose.onNodeWithText("Add torrent").performClick()

        assertEquals(true, opened)
    }

    @Test
    fun actionErrorCanBeDismissed() {
        var dismissed = false
        render(
            RemagnetUiState(
                loaded = true,
                actionError = "An archive download is already running.",
            ),
            onDismissActionError = { dismissed = true },
        )

        compose.onNodeWithText("An archive download is already running.")
            .assertIsDisplayed()
        compose.onNodeWithText("Dismiss").performClick()

        assertEquals(true, dismissed)
    }
}
