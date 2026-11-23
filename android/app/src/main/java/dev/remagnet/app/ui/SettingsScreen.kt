package dev.remagnet.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.data.OnboardingResult
import dev.remagnet.app.data.PairingLink
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.SettingsError
import dev.remagnet.app.data.SettingsField
import dev.remagnet.app.data.parseOnboarding
import dev.remagnet.app.ui.components.Field
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.StatusNote
import dev.remagnet.app.ui.components.StatusTone
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    saved: RemagnetSettings,
    scanResult: String?,
    onScanResultConsumed: () -> Unit,
    pairing: PairingState,
    onScanPairing: (PairingLink) -> Unit,
    onPairingConsumed: () -> Unit,
    onScanCode: () -> Unit,
    onBack: () -> Unit,
    onSave: suspend (RemagnetSettings) -> SaveResult,
    proxyStatus: ProxyStatus?,
    checkingProxy: Boolean,
    onTestConnection: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember(saved) { mutableStateOf(saved) }
    var errors by remember(saved) { mutableStateOf(emptyList<SettingsError>()) }
    var message by remember { mutableStateOf<FormMessage?>(null) }
    var saving by remember { mutableStateOf(false) }
    var showPaste by remember { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val dirty = draft.normalized() != saved.normalized()

    fun applyImport(text: String) {
        when (val result = parseOnboarding(text)) {
            is OnboardingResult.Parsed -> {
                draft = result.payload.applyTo(draft).normalized()
                errors = emptyList()
                message = FormMessage(
                    "Imported connection settings. Review the values, then save.",
                    StatusTone.Ok,
                )
            }

            is OnboardingResult.Pairing -> {
                message = FormMessage("Claiming pairing code…", StatusTone.Neutral)
                onScanPairing(result.link)
            }

            is OnboardingResult.Invalid -> {
                message = FormMessage(result.message, StatusTone.Error)
            }
        }
    }

    fun edit(next: RemagnetSettings) {
        draft = next
        errors = emptyList()
        message = null
    }

    fun requestBack() {
        if (dirty) confirmDiscard = true else onBack()
    }

    BackHandler(onBack = ::requestBack)

    LaunchedEffect(scanResult) {
        if (scanResult != null) {
            applyImport(scanResult)
            onScanResultConsumed()
        }
    }

    LaunchedEffect(pairing) {
        when (val current = pairing) {
            PairingState.Idle -> Unit
            PairingState.Claiming -> {
                message = FormMessage("Claiming pairing code…", StatusTone.Neutral)
            }

            is PairingState.Failed -> {
                message = FormMessage(current.message, StatusTone.Error)
                onPairingConsumed()
            }

            is PairingState.Paired -> {
                // Pairing saves immediately, so the form mirrors the stored
                // values and the user has nothing left to confirm.
                draft = current.settings
                errors = emptyList()
                message = FormMessage(
                    "Paired with Remagnet Proxy. Connection saved.",
                    StatusTone.Ok,
                )
                onPairingConsumed()
            }
        }
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            ScreenHeader(
                surface = "Settings",
                actionText = "Done",
                onAction = ::requestBack,
            )
        }

        item {
            Column {
                Text(
                    text = "Connection settings",
                    color = RemagnetPalette.Text,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "Pair this phone with your Remagnet Proxy. " +
                        "qBittorrent credentials stay on the proxy.",
                    color = RemagnetPalette.Muted,
                    style = MaterialTheme.typography.bodyMedium,
                    lineHeight = 19.sp,
                )
            }
        }

        item {
            Panel {
                SectionLabel("Pairing")
                Text(
                    text = "Pair with Remagnet Proxy",
                    color = RemagnetPalette.Text,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "Scan the code shown by your proxy, or paste a " +
                        "remagnet://pair link. Pairing saves the URL and token for you.",
                    color = RemagnetPalette.Muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(
                        text = "Scan code",
                        onClick = onScanCode,
                        modifier = Modifier.weight(1f),
                    )
                    SecondaryButton(
                        text = "Paste code",
                        onClick = { showPaste = true },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        item {
            Panel {
                SectionLabel("Manual connection")
                Field(
                    label = "Remagnet Proxy URL",
                    value = draft.proxyBaseUrl,
                    onValueChange = {
                        edit(draft.copy(proxyBaseUrl = it))
                    },
                    placeholder = "https://remagnet.example.com",
                    error = errors.messageFor(SettingsField.ProxyUrl),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                    ),
                )
                SecretField(
                    label = "Remagnet Proxy token",
                    value = draft.proxyToken,
                    onValueChange = { edit(draft.copy(proxyToken = it)) },
                    error = errors.messageFor(SettingsField.ProxyToken),
                    help = "Shown by the proxy when you create a token.",
                )
            }
        }

        message?.let { current ->
            item { StatusNote(text = current.text, tone = current.tone) }
        }

        if (errors.isNotEmpty()) {
            item {
                StatusNote(
                    text = "${errors.size} field${if (errors.size == 1) "" else "s"} " +
                        "still need attention.",
                    tone = StatusTone.Error,
                )
            }
        }

        item {
            PrimaryButton(
                text = if (saving) "Saving…" else "Save settings",
                onClick = {
                    scope.launch {
                        saving = true
                        message = null
                        when (val result = onSave(draft)) {
                            is SaveResult.Saved -> {
                                draft = result.settings
                                errors = emptyList()
                                message = FormMessage("Settings saved.", StatusTone.Ok)
                            }

                            is SaveResult.Invalid -> {
                                errors = result.errors
                                message = null
                            }

                            is SaveResult.Failed -> {
                                message = FormMessage(result.message, StatusTone.Error)
                            }
                        }
                        saving = false
                    }
                },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (!dirty && saved.proxyConfigured) {
            item { SectionLabel("Connection status") }
            item {
                ProxyPanel(
                    settings = saved,
                    status = proxyStatus,
                    checking = checkingProxy,
                    onTest = onTestConnection,
                )
            }
        }

        item {
            Text(
                text = "The Remagnet Proxy token is encrypted with a key held by " +
                    "the Android Keystore.",
                color = RemagnetPalette.Muted,
                fontFamily = GeistMono,
                fontSize = 10.sp,
                lineHeight = 15.sp,
            )
        }
    }

    if (showPaste) {
        PasteCodeDialog(
            onDismiss = { showPaste = false },
            onImport = { text ->
                showPaste = false
                applyImport(text)
            },
        )
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard changes?") },
            text = { Text("The connection settings in this form have not been saved.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDiscard = false
                        onBack()
                    },
                ) { Text("Discard") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) { Text("Keep editing") }
            },
        )
    }
}

@Composable
private fun SecretField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    error: String?,
    help: String? = null,
) {
    var revealed by remember { mutableStateOf(false) }
    Field(
        label = label,
        value = value,
        onValueChange = onValueChange,
        error = error,
        help = help,
        visualTransformation = if (revealed) {
            VisualTransformation.None
        } else {
            PasswordVisualTransformation()
        },
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            imeAction = ImeAction.Next,
        ),
        trailingContent = {
            Text(
                text = if (revealed) "HIDE" else "SHOW",
                color = RemagnetPalette.Accent,
                fontFamily = GeistMono,
                fontSize = 9.sp,
                letterSpacing = 0.8.sp,
                modifier = Modifier
                    .clickable { revealed = !revealed }
                    .semantics {
                        role = Role.Button
                        contentDescription = if (revealed) "Hide $label" else "Show $label"
                    }
                    .padding(horizontal = 8.dp, vertical = 10.dp),
            )
        },
    )
}

@Composable
private fun PasteCodeDialog(
    onDismiss: () -> Unit,
    onImport: (String) -> Unit,
) {
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Paste pairing code") },
        text = {
            Column {
                Text(
                    text = "Paste a remagnet://pair link from your Remagnet Proxy. " +
                        "A remagnet://connect link or JSON with the proxy URL and token " +
                        "also works.",
                    color = RemagnetPalette.Muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 5,
                    textStyle = MaterialTheme.typography.bodySmall.copy(
                        color = RemagnetPalette.Text,
                        fontFamily = GeistMono,
                        fontSize = 11.sp,
                    ),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = RemagnetPalette.Accent,
                        unfocusedBorderColor = RemagnetPalette.Line,
                        focusedContainerColor = RemagnetPalette.Panel,
                        unfocusedContainerColor = RemagnetPalette.Panel,
                        cursorColor = RemagnetPalette.Accent,
                        focusedTextColor = RemagnetPalette.Text,
                        unfocusedTextColor = RemagnetPalette.Text,
                    ),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onImport(code) },
                enabled = code.isNotBlank(),
            ) { Text("Connect") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

private fun List<SettingsError>.messageFor(field: SettingsField): String? =
    firstOrNull { it.field == field }?.message

private data class FormMessage(val text: String, val tone: StatusTone)
