package dev.remagnet.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.magnet.MagnetLink
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Compose UI tests for the magnet review sheet. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class AddMagnetSheetUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val settings = RemagnetSettings(
        proxyBaseUrl = "https://proxy.example",
        proxyToken = "test-token-12345",
    )

    private val magnet = MagnetLink(
        uri = "magnet:?xt=urn:btih:${"a".repeat(40)}&dn=Test+ISO",
        infoHash = "a".repeat(40),
        displayName = "Test ISO",
        sizeBytes = 700L * 1024 * 1024,
        trackers = listOf("udp://tracker.example:1337"),
    )

    private fun render(
        state: AddSheetState,
        onSubmit: () -> Unit = {},
        onDismiss: () -> Unit = {},
        onDraftChange: (String) -> Unit = {},
    ) {
        compose.setContent {
            RemagnetTheme {
                AddMagnetSheet(
                    state = state,
                    settings = settings,
                    onDismiss = onDismiss,
                    onDraftChange = onDraftChange,
                    onReview = {},
                    onPausedChange = {},
                    onSubmit = onSubmit,
                    onRetryDuplicate = {},
                    onEdit = {},
                    onAddAnother = {},
                    onOpenSettings = {},
                )
            }
        }
    }

    @Test
    fun reviewShowsMagnetDetailsAndAllowsSend() {
        var sent = false
        render(
            state = AddSheetState.Review(magnet = magnet, duplicate = DuplicateState.Clear),
            onSubmit = { sent = true },
        )

        compose.onNodeWithText("Test ISO").assertIsDisplayed()
        compose.onNodeWithText("a".repeat(40)).assertIsDisplayed()
        compose.onNodeWithText("700 MB").assertIsDisplayed()
        compose.onNodeWithText("Not in qBittorrent yet.").assertIsDisplayed()
        compose.onNodeWithText("Send to qBittorrent")
            .performScrollTo()
            .assertIsDisplayed()
            .assertIsEnabled()
            .performClick()

        assertEquals(true, sent)
    }

    @Test
    fun existingTorrentBlocksSend() {
        render(
            AddSheetState.Review(
                magnet = magnet,
                duplicate = DuplicateState.Existing(
                    TorrentSummary(
                        hash = magnet.infoHash!!,
                        name = "Test ISO",
                        state = TorrentState.Seeding,
                        rawState = "stalledUP",
                        progress = 1.0,
                        size = 700L * 1024 * 1024,
                        downloadSpeed = 0,
                        uploadSpeed = 0,
                        eta = 0,
                        ratio = 1.0,
                        category = "remagnet",
                        tags = listOf("remagnet"),
                        seeds = 0,
                        peers = 1,
                        addedOn = 0,
                    ),
                ),
            ),
        )

        compose.onNodeWithText(
            "Already in qBittorrent: Test ISO (Seeding · 100%).",
        ).assertIsDisplayed()
        compose.onNodeWithText("Send to qBittorrent").assertIsNotEnabled()
    }

    @Test
    fun lookupFailureStillAllowsRetryingTheAdd() {
        render(
            AddSheetState.Review(
                magnet = magnet,
                duplicate = DuplicateState.Failed("Timed out."),
            ),
        )

        compose.onNodeWithText("Could not check for duplicates. Timed out.")
            .assertIsDisplayed()
        compose.onNodeWithText("Retry check").assertIsDisplayed()
        compose.onNodeWithText("Send to qBittorrent").assertIsEnabled()
    }

    @Test
    fun pasteSheetRequiresALinkBeforeReview() {
        var draft = ""
        render(
            state = AddSheetState.Paste(),
            onDraftChange = { draft = it },
        )

        compose.onNodeWithText("Review").assertIsNotEnabled()
        compose.onNodeWithText("MAGNET LINK").assertIsDisplayed()
        compose.onNodeWithText("magnet:?xt=urn:btih:…").performTextInput("magnet:?xt=")
        assertEquals("magnet:?xt=", draft)
    }

    @Test
    fun addedSheetReportsSuccess() {
        var dismissed = false
        render(
            state = AddSheetState.Added(
                name = "Test ISO",
                category = "remagnet",
                tags = listOf("remagnet"),
            ),
            onDismiss = { dismissed = true },
        )

        compose.onNodeWithText("Remagnet Proxy sent the magnet to qBittorrent.")
            .assertIsDisplayed()
        compose.onNodeWithText("Done").performClick()

        assertEquals(true, dismissed)
    }

    @Test
    fun submitErrorKeepsTheMagnetInTheSheet() {
        render(
            AddSheetState.Review(
                magnet = magnet,
                duplicate = DuplicateState.Clear,
                error = "qBittorrent rejected the magnet.",
            ),
        )

        compose.onNodeWithText("qBittorrent rejected the magnet.").assertIsDisplayed()
        compose.onNodeWithText("Send to qBittorrent").assertIsEnabled()
    }
}
