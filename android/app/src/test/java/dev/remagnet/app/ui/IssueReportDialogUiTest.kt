package dev.remagnet.app.ui

import android.content.ClipboardManager
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.BuildConfig
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.theme.RemagnetTheme
import dev.remagnet.app.util.IssueReportContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Compose UI tests for the opt-in issue report dialog and its entry points. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class IssueReportDialogUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun render(
        context: IssueReportContext?,
        backend: String? = null,
        onDismiss: () -> Unit = {},
    ) {
        compose.setContent {
            RemagnetTheme {
                IssueReportDialog(context = context, backend = backend, onDismiss = onDismiss)
            }
        }
    }

    @Test
    fun dialogExplainsPrivacyAndShowsRedactedDiagnostics() {
        render(
            IssueReportContext(
                action = "Connection check",
                message = "GET https://proxy.example failed with token rmg_secret123",
            ),
        )

        compose.onNodeWithText("Report an issue").assertIsDisplayed()
        compose.onNodeWithText(
            "Nothing is sent automatically. Review the redacted diagnostics below before " +
                "choosing how to report.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Component: Android app", substring = true)
            .assertIsDisplayed()
        compose.onNodeWithText("Action: Connection check", substring = true)
            .assertIsDisplayed()
        compose.onNodeWithText("[redacted-url]", substring = true).assertIsDisplayed()
        compose.onNodeWithText("[redacted-token]", substring = true).assertIsDisplayed()
        compose.onNodeWithText("rmg_secret123", substring = true).assertDoesNotExist()
        compose.onNodeWithText("https://proxy.example", substring = true).assertDoesNotExist()
    }

    @Test
    fun backendFillsInWhenTheContextDoesNotSetOne() {
        render(
            IssueReportContext(action = "Torrent list"),
            backend = "qBittorrent 5.0.2",
        )

        compose.onNodeWithText("Backend: qBittorrent 5.0.2", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun explicitContextBackendWinsOverTheLiveBackend() {
        render(
            IssueReportContext(
                action = "Connection check",
                backend = "qBittorrent 5.0.2",
                message = "Timed out.",
            ),
            backend = "Transmission 4.0",
        )

        compose.onNodeWithText("Backend: qBittorrent 5.0.2", substring = true)
            .assertIsDisplayed()
        compose.onNodeWithText("Transmission 4.0", substring = true).assertDoesNotExist()
    }

    @Test
    fun copyDiagnosticsWritesTheClipboardAndConfirms() {
        render(IssueReportContext(action = "Settings"))

        compose.onNodeWithText("Copy diagnostics").performClick()

        compose.onNodeWithText("Copied").assertIsDisplayed()
        val clip = compose.activity.getSystemService(ClipboardManager::class.java).primaryClip
        assertNotNull(clip)
        assertEquals("Remagnet diagnostics", clip!!.description.label.toString())
        val text = clip.getItemAt(0).text.toString()
        assertTrue(text.contains("Component: Android app"))
        assertTrue(text.contains("Action: Settings"))
    }

    @Test
    fun openOnGithubStartsAViewIntent() {
        render(null)

        compose.onNodeWithText("Open on GitHub").performClick()

        val started = shadowOf(compose.activity).nextStartedActivity
        assertNotNull(started)
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertTrue(
            started.data.toString()
                .startsWith("https://github.com/EliCunninghamDev/Remagnet/issues/new"),
        )
    }

    @Test
    fun emailReportStartsASendToIntent() {
        render(null)

        compose.onNodeWithText("Email report").performClick()

        val started = shadowOf(compose.activity).nextStartedActivity
        assertNotNull(started)
        assertEquals(Intent.ACTION_SENDTO, started.action)
        assertEquals("mailto", started.data?.scheme)
    }

    @Test
    fun closeDismissesTheDialog() {
        var dismissed = false
        render(null, onDismiss = { dismissed = true })

        compose.onNodeWithText("Close").performClick()

        assertEquals(true, dismissed)
    }

    @Test
    fun homeActionErrorOffersAReportTrigger() {
        var reported: IssueReportContext? = null
        compose.setContent {
            RemagnetTheme {
                HomeScreen(
                    state = RemagnetUiState(
                        loaded = true,
                        actionError = "An archive download is already running.",
                    ),
                    onOpenSettings = {},
                    onScanCode = {},
                    onAddMagnet = {},
                    onRefreshTorrents = {},
                    onDownload = {},
                    onCancelDownload = {},
                    onDismissDownload = {},
                    onRemoveToggle = {},
                    onRemove = { _, _ -> },
                    onCancelRemove = {},
                    onOpenArchive = {},
                    onDismissActionError = {},
                    onReportIssue = { reported = it },
                )
            }
        }

        compose.onNodeWithText("Report issue").performClick()

        assertEquals("Home action error", reported?.action)
        assertEquals("An archive download is already running.", reported?.message)
    }

    @Test
    fun settingsFooterShowsVersionAndReportEntryPoint() {
        var reported: IssueReportContext? = null
        compose.setContent {
            RemagnetTheme {
                SettingsScreen(
                    saved = RemagnetSettings(),
                    scanResult = null,
                    onScanResultConsumed = {},
                    pairing = PairingState.Idle,
                    onScanPairing = {},
                    onPairingConsumed = {},
                    onScanCode = {},
                    onBack = {},
                    onSave = { SaveResult.Saved(it) },
                    proxyStatus = null,
                    checkingProxy = false,
                    onTestConnection = {},
                    onReportIssue = { reported = it },
                )
            }
        }

        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("Remagnet ${BuildConfig.VERSION_NAME}"))
        compose.onNodeWithText("Remagnet ${BuildConfig.VERSION_NAME}").assertIsDisplayed()

        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Report an issue"))
        compose.onNodeWithText("Report an issue").performClick()
        assertNotNull(reported)

        compose.onNodeWithText("Website").assertExists()
        compose.onNodeWithText("GitHub").assertExists()
        compose.onNodeWithText("Privacy").assertExists()
    }
}
