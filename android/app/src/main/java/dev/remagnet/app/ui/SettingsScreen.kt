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
import dev.remagnet.app.data.AuthMode
import dev.remagnet.app.data.OnboardingResult
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.SettingsError
import dev.remagnet.app.data.SettingsField
import dev.remagnet.app.data.parseOnboarding
import dev.remagnet.app.ui.components.Field
import dev.remagnet.app.ui.components.Panel
import dev.remagnet.app.ui.components.PrimaryButton
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.SectionLabel
import dev.remagnet.app.ui.components.SegmentedChoice
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
    onScanCode: () -> Unit,
    onBack: () -> Unit,
    onSave: suspend (RemagnetSettings) -> SaveResult,
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

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RemagnetWordmark(surface = "Settings")
                Spacer(Modifier.weight(1f))
                SecondaryButton(text = "Done", onClick = ::requestBack)
            }
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
                    text = "Point Remagnet at your qBittorrent Web UI. The download " +
                        "proxy is optional and only used for completed ZIP downloads.",
                    color = RemagnetPalette.Muted,
                    style = MaterialTheme.typography.bodyMedium,
                    lineHeight = 19.sp,
                )
            }
        }

        item {
            Panel {
                SectionLabel("Torrent client")
                Field(
                    label = "Web UI URL",
                    value = draft.qbitBaseUrl,
                    onValueChange = { edit(draft.copy(qbitBaseUrl = it)) },
                    placeholder = "http://127.0.0.1:8080",
                    error = errors.messageFor(SettingsField.QbitUrl),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                    ),
                )
                SectionLabel("Authentication")
                SegmentedChoice(
                    options = listOf(
                        "API key" to (draft.authMode == AuthMode.ApiKey),
                        "Password" to (draft.authMode == AuthMode.Password),
                    ),
                    onSelect = { index ->
                        edit(
                            draft.copy(
                                authMode = if (index == 0) AuthMode.ApiKey else AuthMode.Password,
                            ),
                        )
                    },
                )
                when (draft.authMode) {
                    AuthMode.ApiKey -> SecretField(
                        label = "API key",
                        value = draft.qbitApiKey,
                        onValueChange = { edit(draft.copy(qbitApiKey = it)) },
                        error = errors.messageFor(SettingsField.QbitApiKey),
                        help = "qBittorrent 5.2+ → Preferences → Web UI → API Key.",
                    )

                    AuthMode.Password -> {
                        Field(
                            label = "Username",
                            value = draft.qbitUsername,
                            onValueChange = {
                                edit(draft.copy(qbitUsername = it))
                            },
                            error = errors.messageFor(SettingsField.QbitUsername),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Text,
                                imeAction = ImeAction.Next,
                            ),
                        )
                        SecretField(
                            label = "Password",
                            value = draft.qbitPassword,
                            onValueChange = {
                                edit(draft.copy(qbitPassword = it))
                            },
                            error = errors.messageFor(SettingsField.QbitPassword),
                        )
                    }
                }
                Field(
                    label = "Category",
                    value = draft.defaultCategory,
                    onValueChange = {
                        edit(draft.copy(defaultCategory = it))
                    },
                    help = "Applied to magnets added from Remagnet. Optional.",
                )
                Field(
                    label = "Tags",
                    value = draft.defaultTags,
                    onValueChange = { edit(draft.copy(defaultTags = it)) },
                    help = "Comma-separated. Applied to magnets added from Remagnet.",
                )
            }
        }

        item {
            Panel {
                SectionLabel("Download proxy (optional)")
                Field(
                    label = "Proxy URL",
                    value = draft.proxyBaseUrl,
                    onValueChange = {
                        edit(draft.copy(proxyBaseUrl = it))
                    },
                    placeholder = "https://remagnet.example.com",
                    error = errors.messageFor(SettingsField.ProxyUrl),
                    help = "Leave this and the token blank to disable ZIP downloads.",
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                    ),
                )
                SecretField(
                    label = "Proxy token",
                    value = draft.proxyToken,
                    onValueChange = { edit(draft.copy(proxyToken = it)) },
                    error = errors.messageFor(SettingsField.ProxyToken),
                    help = "The same BRIDGE_TOKEN configured on the proxy.",
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

        item {
            Text(
                text = "The API key, password and proxy token are encrypted with a " +
                    "key held by the Android Keystore.",
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
        title = { Text("Import connect code") },
        text = {
            Column {
                Text(
                    text = "Paste a remagnet://connect link or the JSON from a code.",
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
            ) { Text("Import") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

private fun List<SettingsError>.messageFor(field: SettingsField): String? =
    firstOrNull { it.field == field }?.message

private data class FormMessage(val text: String, val tone: StatusTone)
