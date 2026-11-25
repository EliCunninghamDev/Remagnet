package dev.remagnet.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Compose UI tests for the stateless scanner overlay. The camera binding lives
 * in [QrScannerScreen], so these run on Robolectric without camera hardware.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class QrScannerScreenUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val prompt =
        "Point the camera at the QR code on your Remagnet Proxy page."

    private fun render(
        hasFlash: Boolean = false,
        torchEnabled: Boolean = false,
        cameraError: String? = null,
        onClose: () -> Unit = {},
        onPasteCode: () -> Unit = {},
        onToggleFlash: () -> Unit = {},
    ) {
        compose.setContent {
            RemagnetTheme {
                QrScannerContent(
                    onClose = onClose,
                    onPasteCode = onPasteCode,
                    hasFlash = hasFlash,
                    torchEnabled = torchEnabled,
                    onToggleFlash = onToggleFlash,
                    cameraError = cameraError,
                )
            }
        }
    }

    @Test
    fun scannerShowsTitlePromptAndActions() {
        render()

        compose.onNodeWithText("Scan code").assertIsDisplayed()
        compose.onNodeWithText("Close").assertIsDisplayed()
        compose.onNodeWithText(prompt).assertIsDisplayed()
        compose.onNodeWithText("Paste code instead").assertIsDisplayed()
    }

    @Test
    fun flashToggleIsHiddenWithoutFlashUnit() {
        render(hasFlash = false)

        compose.onAllNodesWithText("Flash on").assertCountEquals(0)
        compose.onAllNodesWithText("Flash off").assertCountEquals(0)
    }

    @Test
    fun flashToggleAppearsAndFlipsState() {
        var torch by mutableStateOf(false)
        compose.setContent {
            RemagnetTheme {
                QrScannerContent(
                    onClose = {},
                    onPasteCode = {},
                    hasFlash = true,
                    torchEnabled = torch,
                    onToggleFlash = { torch = !torch },
                )
            }
        }

        compose.onNodeWithText("Flash on").assertIsDisplayed()
        compose.onNodeWithText("Flash on").performClick()

        compose.onNodeWithText("Flash off").assertIsDisplayed()
        compose.onAllNodesWithText("Flash on").assertCountEquals(0)
    }

    @Test
    fun closeAndPasteInvokeCallbacks() {
        var closes = 0
        var pastes = 0
        render(
            onClose = { closes++ },
            onPasteCode = { pastes++ },
        )

        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("Paste code instead").performClick()

        assertEquals(1, closes)
        assertEquals(1, pastes)
    }

    @Test
    fun cameraErrorShowsFallbackPanel() {
        render(cameraError = "The camera is in use or unavailable.")

        compose.onNodeWithText("Camera unavailable").assertIsDisplayed()
        compose.onNodeWithText("The camera is in use or unavailable.").assertIsDisplayed()
        compose.onNodeWithText("Paste code").assertIsDisplayed()
        compose.onNodeWithText("Close").assertIsDisplayed()
        compose.onAllNodesWithText("Paste code instead").assertCountEquals(0)
    }
}
