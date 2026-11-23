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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
    signIn: SignInState = SignInState.Idle,
    onSignIn: (String, String, String, String, String) -> Unit = { _, _, _, _, _ -> },
    onClearSignIn: () -> Unit = {},
    onDisconnect: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var draft by remember(saved) { mutableStateOf(saved) }
    var errors by remember(saved) { mutableStateOf(emptyList<SettingsError>()) }
    var message by remember { mutableStateOf<FormMessage?>(null) }
    var signInMessage by remember { mutableStateOf<FormMessage?>(null) }
    var saving by remember { mutableStateOf(false) }
    var showPaste by remember { mutableStateOf(false) }
    var manualOpen by rememberSaveable { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var signInUrl by rememberSaveable { mutableStateOf(saved.proxyBaseUrl) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var totpCode by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    val dirty = draft.normalized() != saved.normalized()
    val needsTotp = signIn is SignInState.TotpRequired
    val signingIn = signIn is SignInState.SigningIn
    val canSignIn = !signingIn &&
        signInUrl.isNotBlank() &&
        username.isNotBlank() &&
        password.isNotBlank() &&
        (!needsTotp || totpCode.isNotBlank())

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

    LaunchedEffect(saved.proxyBaseUrl) {
        signInUrl = saved.proxyBaseUrl
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

    LaunchedEffect(signIn) {
        when (val current = signIn) {
            SignInState.Idle -> Unit
            SignInState.SigningIn -> {
                signInMessage = FormMessage("Signing in…", StatusTone.Neutral)
            }

            is SignInState.TotpRequired -> {
                signInMessage = FormMessage(current.message, StatusTone.Warn)
            }

            is SignInState.Failed -> {
                signInMessage = FormMessage(current.message, StatusTone.Error)
            }

            is SignInState.SignedIn -> {
                // The password and second factor are never persisted, so drop
                // them as soon as the proxy has minted the device token.
                password = ""
                totpCode = ""
                signInMessage = FormMessage(
                    "Signed in to Remagnet Proxy as ${current.deviceName}.",
                    StatusTone.Ok,
                )
                onClearSignIn()
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
                    text = "Pair this phone with your Remagnet Proxy, sign in with " +
                        "your proxy account, or paste a device token. " +
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
                        "remagnet://pair link. Pairing connects this phone without a " +
                        "password or two-factor code.",
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
                SectionLabel("Account")
                Text(
                    text = "Sign in to Remagnet Proxy",
                    color = RemagnetPalette.Text,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "Use the username and password for this proxy. " +
                        "A two-factor code is requested only when your account " +
                        "requires one.",
                    color = RemagnetPalette.Muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
                Field(
                    label = "Proxy URL",
                    value = signInUrl,
                    onValueChange = {
                        signInUrl = it
                        signInMessage = null
                    },
                    placeholder = "https://remagnet.example.com",
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                    ),
                )
                Field(
                    label = "Username",
                    value = username,
                    onValueChange = {
                        username = it
                        signInMessage = null
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Next,
                    ),
                )
                SecretField(
                    label = "Password",
                    value = password,
                    onValueChange = {
                        password = it
                        signInMessage = null
                    },
                )
                Field(
                    label = "Device name (optional)",
                    value = deviceName,
                    onValueChange = { deviceName = it },
                    placeholder = "Pixel 9",
                    help = "Shown in the proxy's device list. Leave blank to use this phone's name.",
                )
                if (needsTotp) {
                    Field(
                        label = "Two-factor code",
                        value = totpCode,
                        onValueChange = { totpCode = it },
                        placeholder = "123456 or recovery code",
                        help = "Enter the current code from your authenticator, or a recovery code.",
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Text,
                            imeAction = ImeAction.Done,
                        ),
                    )
                }
                signInMessage?.let { current ->
                    StatusNote(text = current.text, tone = current.tone)
                }
                PrimaryButton(
                    text = if (signingIn) "Signing in…" else "Sign in",
                    onClick = {
                        onSignIn(
                            signInUrl,
                            username.trim(),
                            password,
                            totpCode.trim(),
                            deviceName.trim(),
                        )
                    },
                    enabled = canSignIn,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (saved.proxyConfigured) {
            item { SectionLabel("Connection status") }
            item {
                ProxyPanel(
                    settings = saved,
                    status = proxyStatus,
                    checking = checkingProxy,
                    onTest = onTestConnection,
                )
            }
            item {
                Panel {
                    Text(
                        text = "Disconnect removes this device's token from the phone. " +
                            "You can pair again or sign in with your proxy account.",
                        color = RemagnetPalette.Muted,
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                    )
                    SecondaryButton(
                        text = "Disconnect",
                        onClick = {
                            password = ""
                            totpCode = ""
                            signInMessage = FormMessage(
                                "Disconnected. Pair again or sign in with your proxy account.",
                                StatusTone.Neutral,
                            )
                            onDisconnect()
                        },
                        danger = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        item {
            Panel {
                SectionLabel("Advanced")
                Text(
                    text = "Manual device token",
                    color = RemagnetPalette.Text,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "If you created a token on the proxy, enter it here. " +
                        "Pairing and sign-in do this for you.",
                    color = RemagnetPalette.Muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
                SecondaryButton(
                    text = if (manualOpen) "Hide manual entry" else "Enter a device token",
                    onClick = { manualOpen = !manualOpen },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (manualOpen) {
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
                        label = "Device token",
                        value = draft.proxyToken,
                        onValueChange = { edit(draft.copy(proxyToken = it)) },
                        placeholder = "rmg_…",
                        error = errors.messageFor(SettingsField.ProxyToken),
                        help = "Starts with rmg_.",
                    )
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
                                        message = FormMessage(
                                            "Settings saved.",
                                            StatusTone.Ok,
                                        )
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
            Text(
                text = "The device token is encrypted with a key held by " +
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
    error: String? = null,
    placeholder: String? = null,
    help: String? = null,
) {
    var revealed by remember { mutableStateOf(false) }
    Field(
        label = label,
        value = value,
        onValueChange = onValueChange,
        placeholder = placeholder,
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
