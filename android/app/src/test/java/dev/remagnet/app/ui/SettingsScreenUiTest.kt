package dev.remagnet.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.ui.theme.RemagnetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Compose UI tests for the pairing, sign-in and manual-token settings paths. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class SettingsScreenUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun render(
        saved: RemagnetSettings = RemagnetSettings(),
        signIn: SignInState = SignInState.Idle,
        onClearSignIn: () -> Unit = {},
        onDisconnect: () -> Unit = {},
    ) {
        compose.setContent {
            RemagnetTheme {
                SettingsScreen(
                    saved = saved,
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
                    signIn = signIn,
                    onSignIn = { _, _, _, _, _ -> },
                    onClearSignIn = onClearSignIn,
                    onDisconnect = onDisconnect,
                )
            }
        }
    }

    @Test
    fun pairingAndSignInExplainBothEnrolmentPaths() {
        render()

        compose.onNodeWithText("Pair with Remagnet Proxy").assertIsDisplayed()
        compose.onNodeWithText(
            "Scan the code shown by your proxy, or paste a remagnet://pair link. " +
                "Pairing connects this phone without a password or two-factor code.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Sign in to Remagnet Proxy").assertIsDisplayed()
        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("USERNAME"))
        compose.onNodeWithText("USERNAME").assertIsDisplayed()
        compose.onNodeWithText("PASSWORD").assertIsDisplayed()
        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("DEVICE NAME (OPTIONAL)"))
        compose.onNodeWithText("DEVICE NAME (OPTIONAL)").assertIsDisplayed()
    }

    @Test
    fun twoFactorFieldOnlyAppearsWhenTheProxyAsksForIt() {
        var signIn by mutableStateOf<SignInState>(SignInState.Idle)
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
                    signIn = signIn,
                    onSignIn = { _, _, _, _, _ -> },
                )
            }
        }

        compose.onAllNodesWithText("TWO-FACTOR CODE").assertCountEquals(0)

        compose.runOnIdle {
            signIn = SignInState.TotpRequired("Enter the two-factor code for this account.")
        }

        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("TWO-FACTOR CODE"))
        compose.onNodeWithText("TWO-FACTOR CODE").assertIsDisplayed()
        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("Enter the two-factor code for this account."))
        compose.onNodeWithText("Enter the two-factor code for this account.")
            .assertIsDisplayed()
    }

    @Test
    fun configuredProxyOffersConnectionStatusAndDisconnect() {
        var disconnected = false
        render(
            saved = RemagnetSettings(
                proxyBaseUrl = "https://proxy.example",
                proxyToken = "0123456789abcdef",
            ),
            onDisconnect = { disconnected = true },
        )

        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("Disconnect"))
        compose.onNodeWithText("Disconnect").performClick()

        assertEquals(true, disconnected)
    }

    @Test
    fun manualDeviceTokenEntryIsAvailableButCollapsed() {
        render()

        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("Enter a device token"))
        compose.onAllNodesWithText("DEVICE TOKEN").assertCountEquals(0)

        compose.onNodeWithText("Enter a device token").performClick()

        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("DEVICE TOKEN"))
        compose.onNodeWithText("DEVICE TOKEN").assertIsDisplayed()
        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("rmg_…"))
        compose.onNodeWithText("rmg_…").assertIsDisplayed()
        compose.onNode(hasScrollAction())
            .performScrollToNode(hasText("Save settings"))
        compose.onNodeWithText("Save settings").assertIsDisplayed()
    }
}
