package dev.remagnet.app.ui

import android.app.Application
import android.app.NotificationManager
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import dev.remagnet.app.client.DeviceLoginClient
import dev.remagnet.app.client.DeviceLoginResult
import dev.remagnet.app.client.PairingClaim
import dev.remagnet.app.client.PairingClient
import dev.remagnet.app.client.ProxyHealthClient
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.client.ProxyTorrentClient
import dev.remagnet.app.client.QbitError
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.TorrentClient
import dev.remagnet.app.client.TorrentFile
import dev.remagnet.app.client.TorrentState
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.data.PairingLink
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.SettingsError
import dev.remagnet.app.data.SettingsRepository
import dev.remagnet.app.data.settingsRepositoryFor
import dev.remagnet.app.data.validateSettings
import dev.remagnet.app.download.ArchiveDownloadService
import dev.remagnet.app.download.ArchiveDownloadState
import dev.remagnet.app.download.ArchiveDownloads
import dev.remagnet.app.download.ArchiveRequest
import dev.remagnet.app.magnet.MagnetIntake
import dev.remagnet.app.magnet.NO_HASH_MESSAGE
import dev.remagnet.app.magnet.PendingTorrentStore
import dev.remagnet.app.magnet.StagedTorrent
import dev.remagnet.app.magnet.TorrentFileInfo
import dev.remagnet.app.magnet.TorrentFileParseResult
import dev.remagnet.app.magnet.isMagnetLink
import dev.remagnet.app.magnet.magnetFromText
import dev.remagnet.app.magnet.parseMagnet
import dev.remagnet.app.magnet.parseTorrentFile
import dev.remagnet.app.proxy.ProxyApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class RemagnetUiState(
    val settings: RemagnetSettings = RemagnetSettings(),
    val loaded: Boolean = false,
    val checkingProxy: Boolean = false,
    val proxyStatus: ProxyStatus? = null,
    val torrents: List<TorrentSummary> = emptyList(),
    val torrentsLoading: Boolean = false,
    val torrentsError: String? = null,
    val expandedHash: String? = null,
    val filesByHash: Map<String, List<TorrentFile>> = emptyMap(),
    val filesLoadingHash: String? = null,
    val filesError: String? = null,
    val confirmingHash: String? = null,
    val removingHash: String? = null,
    val togglingHash: String? = null,
    val bulkPauseBusy: Boolean = false,
    val actionError: String? = null,
    val download: ArchiveDownloadState = ArchiveDownloadState.Idle,
    val addSheet: AddSheetState = AddSheetState.Closed,
    val notice: String? = null,
    val pairing: PairingState = PairingState.Idle,
    val signIn: SignInState = SignInState.Idle,
)

sealed interface SaveResult {
    data class Saved(val settings: RemagnetSettings) : SaveResult

    data class Invalid(val errors: List<SettingsError>) : SaveResult

    data class Failed(val message: String) : SaveResult
}

/** Progress while a scanned `remagnet://pair` code is claimed. */
sealed interface PairingState {
    data object Idle : PairingState

    data object Claiming : PairingState

    data class Failed(val message: String) : PairingState

    /** Claimed and saved proxy settings; the screen reports the result. */
    data class Paired(val settings: RemagnetSettings) : PairingState
}

/** Progress while the proxy username and password are exchanged for a token. */
sealed interface SignInState {
    data object Idle : SignInState

    data object SigningIn : SignInState

    /** The account needs a TOTP or recovery code before a token is minted. */
    data class TotpRequired(val message: String) : SignInState

    /** The token was minted and persisted. Carries no password or code. */
    data class SignedIn(val proxyBaseUrl: String, val deviceName: String) : SignInState

    data class Failed(val message: String) : SignInState
}

class RemagnetViewModel(
    application: Application,
    private val repository: SettingsRepository,
    private val proxyHealth: ProxyHealthClient,
    private val clientFactory: (RemagnetSettings) -> TorrentClient,
    private val savedState: SavedStateHandle,
    private val pairingClient: PairingClient = PairingClient(),
    private val deviceLoginClient: DeviceLoginClient = DeviceLoginClient(),
) : AndroidViewModel(application) {
    /**
     * The default factory in [androidx.lifecycle.SavedStateViewModelFactory]
     * looks for this exact signature, which is what keeps an in-flight magnet
     * review across process death.
     */
    constructor(application: Application, savedState: SavedStateHandle) : this(
        application = application,
        repository = settingsRepositoryFor(application),
        proxyHealth = ProxyHealthClient(),
        clientFactory = { settings -> ProxyTorrentClient.from(settings) },
        savedState = savedState,
    )

    private val _state = MutableStateFlow(RemagnetUiState())
    val state: StateFlow<RemagnetUiState> = _state.asStateFlow()

    /** Let a newer request win when settings or the magnet change mid-flight. */
    private var proxyCheckId = 0
    private var addLookupId = 0
    private var addSubmitId = 0
    private var listRequestId = 0
    private var filesRequestId = 0
    private var pollJob: Job? = null
    private var lastDownloadPath: String? = null

    init {
        val settings = repository.load()
        _state.value = RemagnetUiState(settings = settings, loaded = true)
        if (settings.proxyConfigured) testConnection()

        viewModelScope.launch {
            ArchiveDownloads.state.collect { download ->
                _state.update { it.copy(download = download) }
                if (download is ArchiveDownloadState.Complete &&
                    download.path != lastDownloadPath
                ) {
                    lastDownloadPath = download.path
                    _state.update { it.copy(notice = "Saved ${download.fileName}.") }
                }
            }
        }

        val pendingTorrentPath = savedState.get<String>(KEY_PENDING_TORRENT_PATH)
        val pendingMagnet = savedState.get<String>(KEY_PENDING_MAGNET)
        if (pendingMagnet != null) {
            openMagnet(
                uri = pendingMagnet,
                restorePaused = savedState.get<Boolean>(KEY_PENDING_PAUSED) ?: false,
            )
        } else if (pendingTorrentPath != null) {
            restorePendingTorrent(
                path = pendingTorrentPath,
                filename = savedState.get<String>(KEY_PENDING_TORRENT_FILENAME),
                paused = savedState.get<Boolean>(KEY_PENDING_PAUSED) ?: false,
            )
        } else {
            val draft = savedState.get<String>(KEY_PASTE_DRAFT)
            val error = savedState.get<String>(KEY_PASTE_ERROR)
            if (draft != null || error != null) {
                _state.update {
                    it.copy(addSheet = AddSheetState.Paste(draft.orEmpty(), error))
                }
            }
        }

        // A staged file from an earlier intake is an orphan: the only path the
        // sheet may still need is the one restored above.
        viewModelScope.launch(Dispatchers.IO) {
            PendingTorrentStore.pruneStale(getApplication(), keepPath = pendingTorrentPath)
        }
    }

    /**
     * Validate on the caller's thread, then write off the main thread. Returns
     * the same typed errors the form renders, so the repository boundary and
     * the screen cannot disagree about what is valid.
     */
    suspend fun save(settings: RemagnetSettings): SaveResult {
        val normalized = settings.normalized()
        val errors = validateSettings(normalized)
        if (errors.isNotEmpty()) return SaveResult.Invalid(errors)

        return persist(normalized) { repository.save(normalized) }
    }

    /**
     * Persist connection settings whose token came from the proxy itself, so
     * the manual-entry minimum length is not applied to an `rmg_…` token.
     */
    private suspend fun saveMinted(settings: RemagnetSettings): SaveResult {
        val normalized = settings.normalized()
        if (normalized.proxyBaseUrl.isBlank() || normalized.proxyToken.isBlank()) {
            return SaveResult.Invalid(validateSettings(normalized))
        }

        return persist(normalized) { repository.saveMinted(normalized) }
    }

    private suspend fun persist(
        normalized: RemagnetSettings,
        write: () -> RemagnetSettings,
    ): SaveResult {
        val result = withContext(Dispatchers.IO) {
            try {
                SaveResult.Saved(write())
            } catch (error: Exception) {
                SaveResult.Failed(error.message ?: "The settings could not be saved.")
            }
        }

        if (result is SaveResult.Saved) {
            listRequestId += 1
            _state.update {
                it.copy(
                    settings = result.settings,
                    proxyStatus = null,
                    notice = "Settings saved.",
                    torrents = if (result.settings.proxyConfigured) it.torrents else emptyList(),
                    torrentsError = null,
                )
            }
            if (result.settings.proxyConfigured) {
                testConnection()
                refreshTorrents()
                startPolling()
            } else {
                stopPolling()
            }
        }
        return result
    }

    // ---- Mobile pairing ---------------------------------------------------

    /**
     * Claim a scanned code and save it immediately, so pairing is one step:
     * the phone is connected and its torrent list refreshes as soon as the
     * proxy answers. A rejected or unusable code leaves any existing proxy
     * settings untouched.
     */
    fun pairDevice(link: PairingLink) {
        if (_state.value.pairing == PairingState.Claiming) return
        _state.update { it.copy(pairing = PairingState.Claiming) }

        viewModelScope.launch {
            when (val result = pairingClient.claim(link)) {
                is PairingClaim.Failed -> _state.update {
                    it.copy(pairing = PairingState.Failed(result.message))
                }

                is PairingClaim.Success -> {
                    val paired = RemagnetSettings(
                        proxyBaseUrl = result.settings.proxyBaseUrl,
                        proxyToken = result.settings.proxyToken,
                    ).normalized()

                    when (val saved = saveMinted(paired)) {
                        is SaveResult.Saved -> _state.update {
                            it.copy(pairing = PairingState.Paired(saved.settings))
                        }

                        is SaveResult.Invalid -> _state.update {
                            it.copy(
                                pairing = PairingState.Failed(
                                    saved.errors.joinToString(" ") { error -> error.message },
                                ),
                            )
                        }

                        is SaveResult.Failed -> _state.update {
                            it.copy(pairing = PairingState.Failed(saved.message))
                        }
                    }
                }
            }
        }
    }

    fun clearPairing() {
        _state.update { it.copy(pairing = PairingState.Idle) }
    }

    // ---- Direct proxy sign-in ---------------------------------------------

    /**
     * Exchange the administrator username and password for a per-device token.
     *
     * Only the returned `rmg_…` token is persisted; the password and any TOTP
     * code stay in the form and are cleared by the screen when this succeeds.
     */
    fun signIn(
        proxyBaseUrl: String,
        username: String,
        password: String,
        totpCode: String? = null,
        deviceName: String? = null,
    ) {
        if (_state.value.signIn == SignInState.SigningIn) return
        _state.update { it.copy(signIn = SignInState.SigningIn) }

        viewModelScope.launch {
            when (
                val result = deviceLoginClient.signIn(
                    proxyBaseUrl = proxyBaseUrl,
                    username = username,
                    password = password,
                    totpCode = totpCode,
                    deviceName = deviceName,
                )
            ) {
                is DeviceLoginResult.TotpRequired -> _state.update {
                    it.copy(signIn = SignInState.TotpRequired(result.message))
                }

                is DeviceLoginResult.Failed -> _state.update {
                    it.copy(signIn = SignInState.Failed(result.message))
                }

                is DeviceLoginResult.SignedIn -> {
                    val settings = RemagnetSettings(
                        proxyBaseUrl = result.proxyBaseUrl,
                        proxyToken = result.token,
                    )
                    when (val saved = saveMinted(settings)) {
                        is SaveResult.Saved -> _state.update {
                            it.copy(
                                signIn = SignInState.SignedIn(
                                    proxyBaseUrl = saved.settings.proxyBaseUrl,
                                    deviceName = result.deviceName,
                                ),
                            )
                        }

                        is SaveResult.Invalid -> _state.update {
                            it.copy(
                                signIn = SignInState.Failed(
                                    saved.errors.joinToString(" ") { error -> error.message },
                                ),
                            )
                        }

                        is SaveResult.Failed -> _state.update {
                            it.copy(signIn = SignInState.Failed(saved.message))
                        }
                    }
                }
            }
        }
    }

    fun clearSignInState() {
        _state.update { it.copy(signIn = SignInState.Idle) }
    }

    /**
     * Forget the device token and stop every request. The proxy URL stays so
     * the sign-in form is already pointed at the right server.
     */
    fun disconnect() {
        val current = _state.value
        val connection = current.settings
        stopPolling()
        proxyCheckId += 1
        listRequestId += 1

        val disconnected = RemagnetSettings(
            proxyBaseUrl = current.settings.proxyBaseUrl,
            proxyToken = "",
        ).normalized()

        _state.update {
            it.copy(
                settings = disconnected,
                proxyStatus = null,
                checkingProxy = false,
                torrents = emptyList(),
                torrentsLoading = false,
                torrentsError = null,
                expandedHash = null,
                filesByHash = emptyMap(),
                filesLoadingHash = null,
                filesError = null,
                confirmingHash = null,
                removingHash = null,
                togglingHash = null,
                bulkPauseBusy = false,
                actionError = null,
                pairing = PairingState.Idle,
                signIn = SignInState.Idle,
                notice = "Disconnected from the Remagnet Proxy.",
            )
        }

        viewModelScope.launch {
            val error = withContext(Dispatchers.IO) {
                // Best effort: revoke this device while its token is still
                // available. Offline proxies and already-revoked tokens must
                // not prevent the local disconnect below.
                if (connection.proxyConfigured) {
                    try {
                        ProxyApi(connection.proxyBaseUrl, connection.proxyToken)
                            .devices
                            .revokeCurrentDevice()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // Ignore: the local token is cleared regardless.
                    }
                }

                try {
                    repository.saveDisconnected(disconnected.proxyBaseUrl)
                    null
                } catch (error: Exception) {
                    error.message ?: "The disconnect could not be saved."
                }
            }
            if (error != null) {
                _state.update {
                    it.copy(notice = "Disconnected, but the change could not be saved: $error")
                }
            }
        }
    }

    // ---- Torrent list -----------------------------------------------------

    /**
     * Refresh while the home screen is visible. The poller is cancelled on
     * pause, so a backgrounded Remagnet does not keep talking to the proxy.
     */
    fun startPolling() {
        if (!_state.value.settings.proxyConfigured) return
        if (pollJob?.isActive == true) return

        pollJob = viewModelScope.launch {
            while (isActive) {
                loadTorrents(showLoading = _state.value.torrents.isEmpty())
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    fun refreshTorrents() {
        if (!_state.value.settings.proxyConfigured) return
        viewModelScope.launch { loadTorrents(showLoading = true) }
    }

    private suspend fun loadTorrents(showLoading: Boolean) {
        val settings = _state.value.settings
        if (!settings.proxyConfigured) {
            listRequestId += 1
            _state.update {
                it.copy(torrents = emptyList(), torrentsLoading = false, torrentsError = null)
            }
            return
        }

        val requestId = ++listRequestId
        if (showLoading) _state.update { it.copy(torrentsLoading = true) }

        // The proxy already filters the list by its configured category and
        // tags, so the app renders whatever the server considers Remagnet's.
        val result = clientFactory(settings).listTorrents()
        // A poll cancelled by leaving the screen can surface as a generic
        // client error; it is not a connection problem the user should see.
        if (requestId != listRequestId || !currentCoroutineContext().isActive) return

        when (result) {
            is QbitResult.Success -> _state.update {
                it.copy(
                    torrents = result.value,
                    torrentsLoading = false,
                    torrentsError = null,
                )
            }

            is QbitResult.Failure -> _state.update {
                it.copy(torrentsLoading = false, torrentsError = result.error.message)
            }
        }
    }

    fun toggleRemove(hash: String) {
        _state.update {
            if (it.confirmingHash == hash) {
                it.copy(confirmingHash = null)
            } else {
                it.copy(confirmingHash = hash, actionError = null)
            }
        }
    }

    fun cancelRemove() {
        _state.update { it.copy(confirmingHash = null) }
    }

    fun removeTorrent(torrent: TorrentSummary, deleteFiles: Boolean) {
        val current = _state.value
        if (current.removingHash != null) return
        if (ArchiveDownloads.isActive(torrent.hash)) {
            _state.update {
                it.copy(
                    actionError = "Cancel the archive download before removing this torrent.",
                    confirmingHash = null,
                )
            }
            return
        }
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(
                    actionError = "The Remagnet Proxy is not configured.",
                    confirmingHash = null,
                )
            }
            return
        }

        _state.update {
            it.copy(removingHash = torrent.hash, confirmingHash = null, actionError = null)
        }
        viewModelScope.launch {
            when (val result = clientFactory(current.settings).removeTorrent(
                hashes = listOf(torrent.hash),
                deleteFiles = deleteFiles,
            )) {
                is QbitResult.Success -> {
                    _state.update {
                        it.copy(
                            removingHash = null,
                            notice = "Removed \"${torrent.name}\" from qBittorrent.",
                        )
                    }
                    loadTorrents(showLoading = false)
                }

                is QbitResult.Failure -> _state.update {
                    it.copy(removingHash = null, actionError = result.error.message)
                }
            }
        }
    }

    fun togglePause(torrent: TorrentSummary) {
        val current = _state.value
        if (current.togglingHash != null || current.bulkPauseBusy) return
        if (current.removingHash == torrent.hash) return
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(actionError = "The Remagnet Proxy is not configured.")
            }
            return
        }

        val resume = torrent.state == TorrentState.Stopped
        _state.update { it.copy(togglingHash = torrent.hash, actionError = null) }
        viewModelScope.launch {
            val result = if (resume) {
                clientFactory(current.settings).resumeTorrent(torrent.hash)
            } else {
                clientFactory(current.settings).pauseTorrent(torrent.hash)
            }

            when (result) {
                is QbitResult.Success -> {
                    _state.update {
                        it.copy(
                            togglingHash = null,
                            notice = if (resume) {
                                "Resumed \"${torrent.name}\"."
                            } else {
                                "Paused \"${torrent.name}\"."
                            },
                        )
                    }
                    loadTorrents(showLoading = false)
                }

                is QbitResult.Failure -> _state.update {
                    it.copy(togglingHash = null, actionError = result.error.message)
                }
            }
        }
    }

    fun pauseAllTorrents() {
        val current = _state.value
        if (current.bulkPauseBusy || current.togglingHash != null) return
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(actionError = "The Remagnet Proxy is not configured.")
            }
            return
        }

        _state.update { it.copy(bulkPauseBusy = true, actionError = null) }
        viewModelScope.launch {
            when (val result = clientFactory(current.settings).pauseAllTorrents()) {
                is QbitResult.Success -> {
                    _state.update {
                        it.copy(bulkPauseBusy = false, notice = "Paused all torrents.")
                    }
                    loadTorrents(showLoading = false)
                }

                is QbitResult.Failure -> _state.update {
                    it.copy(bulkPauseBusy = false, actionError = result.error.message)
                }
            }
        }
    }

    fun resumeAllTorrents() {
        val current = _state.value
        if (current.bulkPauseBusy || current.togglingHash != null) return
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(actionError = "The Remagnet Proxy is not configured.")
            }
            return
        }

        _state.update { it.copy(bulkPauseBusy = true, actionError = null) }
        viewModelScope.launch {
            when (val result = clientFactory(current.settings).resumeAllTorrents()) {
                is QbitResult.Success -> {
                    _state.update {
                        it.copy(bulkPauseBusy = false, notice = "Resumed all torrents.")
                    }
                    loadTorrents(showLoading = false)
                }

                is QbitResult.Failure -> _state.update {
                    it.copy(bulkPauseBusy = false, actionError = result.error.message)
                }
            }
        }
    }

    /**
     * Expand or collapse the file browser for one torrent.
     *
     * A request counter keeps a slow response for a previously expanded torrent
     * from overwriting the files of a torrent the user has since opened.
     */
    fun toggleFiles(torrent: TorrentSummary) {
        if (_state.value.expandedHash == torrent.hash) {
            filesRequestId += 1
            _state.update {
                it.copy(expandedHash = null, filesLoadingHash = null, filesError = null)
            }
            return
        }

        val current = _state.value
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(actionError = "The Remagnet Proxy is not configured.")
            }
            return
        }

        val settings = current.settings
        val requestId = ++filesRequestId
        _state.update {
            it.copy(
                expandedHash = torrent.hash,
                filesLoadingHash = torrent.hash,
                filesError = null,
            )
        }

        viewModelScope.launch {
            val result = clientFactory(settings).listTorrentFiles(torrent.hash)
            if (requestId != filesRequestId) return@launch

            when (result) {
                is QbitResult.Success -> _state.update {
                    it.copy(
                        filesByHash = it.filesByHash + (torrent.hash to result.value),
                        filesLoadingHash = null,
                        filesError = null,
                    )
                }

                is QbitResult.Failure -> _state.update {
                    it.copy(filesLoadingHash = null, filesError = result.error.message)
                }
            }
        }
    }

    fun dismissActionError() {
        _state.update { it.copy(actionError = null) }
    }

    // ---- Archive downloads ------------------------------------------------

    fun downloadTorrent(torrent: TorrentSummary) {
        val current = _state.value
        if (!current.settings.archiveReady) {
            _state.update {
                it.copy(actionError = "Add the Remagnet Proxy URL and token in Settings to download archives.")
            }
            return
        }
        if (!torrent.isComplete) {
            _state.update { it.copy(actionError = "That torrent is not complete yet.") }
            return
        }
        if (torrent.hash.isBlank()) {
            _state.update { it.copy(actionError = "That torrent has no info hash.") }
            return
        }
        if (ArchiveDownloads.isActive()) {
            _state.update {
                it.copy(
                    actionError = "An archive download is already running. " +
                        "Wait for it to finish or cancel it first.",
                )
            }
            return
        }
        if (!ArchiveDownloads.claim(torrent.hash, torrent.name, torrent.size)) {
            _state.update { it.copy(actionError = "An archive download is already running.") }
            return
        }

        try {
            ArchiveDownloadService.start(
                getApplication(),
                ArchiveRequest(
                    hash = torrent.hash,
                    name = torrent.name,
                    size = torrent.size,
                ),
            )
        } catch (error: Exception) {
            ArchiveDownloads.fail(
                torrent.hash,
                torrent.name,
                "The download could not start on this device.",
            )
            _state.update {
                it.copy(actionError = error.message ?: "The download could not start.")
            }
        }
    }

    fun downloadTorrentFile(torrent: TorrentSummary, file: TorrentFile) {
        val current = _state.value
        if (!current.settings.archiveReady) {
            _state.update {
                it.copy(actionError = "Add the Remagnet Proxy URL and token in Settings to download archives.")
            }
            return
        }
        if (!file.isComplete) {
            _state.update { it.copy(actionError = "That torrent is not complete yet.") }
            return
        }
        if (torrent.hash.isBlank()) {
            _state.update { it.copy(actionError = "That torrent has no info hash.") }
            return
        }
        if (ArchiveDownloads.isActive()) {
            _state.update {
                it.copy(
                    actionError = "An archive download is already running. " +
                        "Wait for it to finish or cancel it first.",
                )
            }
            return
        }
        if (!ArchiveDownloads.claim(torrent.hash, file.displayName, file.size)) {
            _state.update { it.copy(actionError = "An archive download is already running.") }
            return
        }

        try {
            ArchiveDownloadService.start(
                getApplication(),
                ArchiveRequest(
                    hash = torrent.hash,
                    name = file.displayName,
                    size = file.size,
                    fileIndex = file.index,
                ),
            )
        } catch (error: Exception) {
            ArchiveDownloads.fail(
                torrent.hash,
                file.displayName,
                "The download could not start on this device.",
            )
            _state.update {
                it.copy(actionError = error.message ?: "The download could not start.")
            }
        }
    }

    fun cancelDownload() {
        if (!ArchiveDownloads.isActive()) return
        ArchiveDownloadService.cancel(getApplication())
    }

    fun dismissDownload() {
        ArchiveDownloads.dismiss()
        getApplication<Application>().getSystemService(NotificationManager::class.java)
            ?.cancel(ArchiveDownloadService.NOTIFICATION_ID)
    }

    /** Open the sheet without a torrent so one can be pasted, shared or chosen. */
    fun openAddSheet() {
        addLookupId += 1
        addSubmitId += 1
        clearPendingMagnet()
        clearPendingTorrent()
        clearPasteDraft()
        _state.update { it.copy(addSheet = AddSheetState.Paste()) }
    }

    /**
     * Accept a `VIEW magnet:`, `SEND` or `.torrent` payload. An unusable link
     * still opens the sheet with the draft intact, so a malformed share can be
     * corrected.
     */
    fun acceptIntake(intake: MagnetIntake) {
        when (intake) {
            is MagnetIntake.Magnet -> openMagnet(intake.uri)
            is MagnetIntake.Unusable -> openPaste(intake.draft, intake.message)
            is MagnetIntake.TorrentFile -> acceptTorrentFileUri(Uri.parse(intake.uri))
            MagnetIntake.None -> Unit
        }
    }

    /**
     * Stage a chosen or shared `.torrent` file, parse it, and open review.
     *
     * The URI grant can expire while the process is alive or after it dies, so
     * the file is copied into the app cache first. Parsing happens off the main
     * thread with the same validator the sheet uses for magnets.
     */
    fun acceptTorrentFileUri(uri: Uri) {
        val intakeId = ++addLookupId
        addSubmitId += 1
        val current = _state.value.addSheet
        val draft = (current as? AddSheetState.Paste)?.draft.orEmpty()

        viewModelScope.launch {
            val staged = withContext(Dispatchers.IO) {
                PendingTorrentStore.stageFromUri(getApplication(), uri)
            }
            if (intakeId != addLookupId) {
                if (staged is StagedTorrent.Ready) {
                    withContext(Dispatchers.IO) { PendingTorrentStore.delete(staged.path) }
                }
                return@launch
            }

            when (staged) {
                is StagedTorrent.Failed -> openPaste(draft, staged.message)

                is StagedTorrent.Ready -> {
                    val parsed = withContext(Dispatchers.IO) {
                        parseTorrentFile(staged.bytes, staged.filename)
                    }
                    if (intakeId != addLookupId) {
                        withContext(Dispatchers.IO) { PendingTorrentStore.delete(staged.path) }
                        return@launch
                    }

                    when (parsed) {
                        is TorrentFileParseResult.Invalid -> {
                            withContext(Dispatchers.IO) {
                                PendingTorrentStore.delete(staged.path)
                            }
                            openPaste(draft, parsed.message)
                        }

                        is TorrentFileParseResult.Valid -> {
                            val previousPath =
                                savedState.get<String>(KEY_PENDING_TORRENT_PATH)
                            if (previousPath != null && previousPath != staged.path) {
                                withContext(Dispatchers.IO) {
                                    PendingTorrentStore.delete(previousPath)
                                }
                            }
                            clearPasteDraft()
                            clearPendingMagnet()
                            openTorrentReview(
                                info = parsed.info,
                                stagedPath = staged.path,
                                paused = false,
                            )
                        }
                    }
                }
            }
        }
    }

    fun updateDraft(draft: String) {
        val current = _state.value.addSheet
        if (current !is AddSheetState.Paste) return

        if (draft.isBlank()) {
            savedState.remove<String>(KEY_PASTE_DRAFT)
        } else {
            savedState[KEY_PASTE_DRAFT] = draft
        }
        savedState.remove<String>(KEY_PASTE_ERROR)
        _state.update {
            it.copy(addSheet = current.copy(draft = draft, error = null))
        }
    }

    /** Parse the paste form and continue to review. */
    fun reviewDraft() {
        val current = _state.value.addSheet as? AddSheetState.Paste ?: return
        val draft = current.draft.trim()
        if (draft.isEmpty()) {
            updatePasteError("Paste a magnet link first.")
            return
        }

        val candidate = when {
            isMagnetLink(draft) -> draft
            else -> magnetFromText(draft)
        }
        if (candidate == null) {
            updatePasteError("Paste a magnet link that starts with magnet:?.")
            return
        }
        openMagnet(candidate)
    }

    fun setPaused(paused: Boolean) {
        val review = _state.value.addSheet as? AddSheetState.Review ?: return
        if (review.submitting) return
        savedState[KEY_PENDING_PAUSED] = paused
        updateReview(review.item.key) { it.copy(paused = paused) }
    }

    /** Return to the paste form so the current item can be replaced. */
    fun editReviewedMagnet() {
        val review = _state.value.addSheet as? AddSheetState.Review ?: return
        if (review.submitting) return
        when (val item = review.item) {
            is AddItem.Magnet -> openPaste(item.link.uri, error = null)
            // Leaving review abandons the staged copy; choosing again stages a
            // fresh file, and closeAddSheet would delete it anyway.
            is AddItem.TorrentFile -> openPaste("", error = null)
        }
    }

    fun retryDuplicateCheck() {
        val review = _state.value.addSheet as? AddSheetState.Review ?: return
        if (review.submitting) return
        updateReview(review.item.key) {
            it.copy(duplicate = DuplicateState.Checking, error = null)
        }
        checkDuplicate(review.item)
    }

    fun submitMagnet() {
        val current = _state.value
        val review = current.addSheet as? AddSheetState.Review ?: return
        if (!review.canSubmit) return
        val item = review.item

        if (!current.settings.proxyConfigured) {
            updateReview(item.key) {
                it.copy(duplicate = DuplicateState.NotConfigured)
            }
            return
        }

        val submitId = ++addSubmitId
        val settings = current.settings
        updateReview(item.key) { it.copy(submitting = true, error = null) }

        viewModelScope.launch {
            val request = when (item) {
                is AddItem.Magnet -> addRequestFor(item.link, review.paused)

                is AddItem.TorrentFile -> {
                    val bytes = withContext(Dispatchers.IO) {
                        PendingTorrentStore.readStaged(item.stagedPath)
                    }
                    if (bytes == null) {
                        updateReview(item.key) {
                            it.copy(
                                submitting = false,
                                error = STAGED_TORRENT_MISSING,
                            )
                        }
                        return@launch
                    }
                    addRequestFor(item.info, bytes, review.paused)
                }
            }

            val result = clientFactory(settings).addTorrent(request)
            if (submitId != addSubmitId) return@launch

            when (result) {
                is QbitResult.Success -> {
                    val name = item.label
                    clearPendingMagnet()
                    clearPendingTorrent()
                    // The proxy applies its configured category and tags, so
                    // the summary shows what it actually used rather than any
                    // value this device guessed.
                    _state.update {
                        it.copy(
                            addSheet = AddSheetState.Added(
                                name = name,
                                category = result.value.category,
                                tags = result.value.tags,
                            ),
                            notice = "Added \"$name\" to qBittorrent.",
                        )
                    }
                    refreshTorrents()
                }

                is QbitResult.Failure -> {
                    updateReview(item.key) {
                        it.copy(submitting = false, error = result.error.message)
                    }
                    // qBittorrent rejects a duplicate even when the lookup said
                    // the hash was clear, for example if another client added
                    // it first. Re-check so the sheet explains why.
                    if (result.error is QbitError.Rejected) checkDuplicate(item)
                }
            }
        }
    }

    /** Successful add finished; offer the paste form again. */
    fun addAnother() {
        openAddSheet()
    }

    /**
     * Close the sheet. An in-flight add keeps it open so its result has
     * somewhere to land; the sheet itself also refuses the swipe while busy.
     */
    fun closeAddSheet() {
        val current = _state.value.addSheet
        if (current is AddSheetState.Review && current.submitting) return

        addLookupId += 1
        addSubmitId += 1
        clearPendingMagnet()
        clearPendingTorrent()
        clearPasteDraft()
        _state.update { it.copy(addSheet = AddSheetState.Closed) }
    }

    private fun openMagnet(uri: String, restorePaused: Boolean? = null) {
        val link = parseMagnet(uri)
        if (link?.infoHash == null) {
            openPaste(link?.uri ?: uri, NO_HASH_MESSAGE)
            return
        }

        val item = AddItem.Magnet(link)
        // Activity recreation can deliver the same intent that is already
        // restored from saved state. Do not restart the lookup for it.
        val current = _state.value.addSheet
        if (current is AddSheetState.Review && current.item.key == item.key) return

        val paused = restorePaused
            ?: (current as? AddSheetState.Review)?.paused
            ?: false
        clearPasteDraft()
        clearPendingTorrent()
        savedState[KEY_PENDING_MAGNET] = link.uri
        savedState[KEY_PENDING_PAUSED] = paused
        addLookupId += 1
        addSubmitId += 1
        _state.update {
            it.copy(
                addSheet = AddSheetState.Review(
                    item = item,
                    paused = paused,
                    duplicate = DuplicateState.Checking,
                ),
            )
        }
        checkDuplicate(item)
    }

    /** Restore a staged `.torrent` after process death, if it is still readable. */
    private fun restorePendingTorrent(path: String, filename: String?, paused: Boolean) {
        addLookupId += 1
        addSubmitId += 1
        val restoreId = addLookupId

        viewModelScope.launch {
            val parsed = withContext(Dispatchers.IO) {
                PendingTorrentStore.readStaged(path)?.let { bytes ->
                    parseTorrentFile(bytes, filename)
                }
            }
            if (restoreId != addLookupId) return@launch

            when (parsed) {
                null -> {
                    clearPendingTorrent()
                    openPaste("", STAGED_TORRENT_MISSING)
                }

                is TorrentFileParseResult.Invalid -> {
                    clearPendingTorrent()
                    openPaste("", parsed.message)
                }

                is TorrentFileParseResult.Valid -> {
                    openTorrentReview(
                        info = parsed.info,
                        stagedPath = path,
                        paused = paused,
                    )
                }
            }
        }
    }

    /** Persist a parsed `.torrent` and open its review with a duplicate check. */
    private fun openTorrentReview(
        info: TorrentFileInfo,
        stagedPath: String,
        paused: Boolean,
    ) {
        savedState.remove<String>(KEY_PENDING_MAGNET)
        savedState[KEY_PENDING_TORRENT_PATH] = stagedPath
        savedState[KEY_PENDING_TORRENT_FILENAME] = info.filename
        savedState[KEY_PENDING_PAUSED] = paused
        addLookupId += 1
        addSubmitId += 1

        val item = AddItem.TorrentFile(info, stagedPath)
        _state.update {
            it.copy(
                addSheet = AddSheetState.Review(
                    item = item,
                    paused = paused,
                    duplicate = DuplicateState.Checking,
                ),
            )
        }
        checkDuplicate(item)
    }

    private fun openPaste(draft: String, error: String?) {
        addLookupId += 1
        addSubmitId += 1
        clearPendingMagnet()
        clearPendingTorrent()
        if (draft.isBlank()) {
            savedState.remove<String>(KEY_PASTE_DRAFT)
        } else {
            savedState[KEY_PASTE_DRAFT] = draft
        }
        if (error == null) {
            savedState.remove<String>(KEY_PASTE_ERROR)
        } else {
            savedState[KEY_PASTE_ERROR] = error
        }
        _state.update { it.copy(addSheet = AddSheetState.Paste(draft, error)) }
    }

    private fun updatePasteError(message: String) {
        val current = _state.value.addSheet as? AddSheetState.Paste ?: return
        savedState[KEY_PASTE_ERROR] = message
        _state.update { it.copy(addSheet = current.copy(error = message)) }
    }

    private fun checkDuplicate(item: AddItem) {
        val hash = item.infoHash ?: return

        if (!_state.value.settings.proxyConfigured) {
            updateReview(item.key) {
                it.copy(duplicate = DuplicateState.NotConfigured)
            }
            return
        }

        val lookupId = ++addLookupId
        val settings = _state.value.settings
        viewModelScope.launch {
            val result = clientFactory(settings).getTorrent(hash)
            if (lookupId != addLookupId) return@launch
            val duplicate = duplicateStateFor(result)
            updateReview(item.key) { it.copy(duplicate = duplicate) }
        }
    }

    private fun updateReview(
        key: String,
        transform: (AddSheetState.Review) -> AddSheetState.Review,
    ) {
        _state.update { current ->
            val sheet = current.addSheet
            if (sheet is AddSheetState.Review && sheet.item.key == key) {
                current.copy(addSheet = transform(sheet))
            } else {
                current
            }
        }
    }

    private fun clearPendingMagnet() {
        savedState.remove<String>(KEY_PENDING_MAGNET)
        savedState.remove<Boolean>(KEY_PENDING_PAUSED)
    }

    /**
     * Forget the staged `.torrent`, deleting its cache copy by default so it
     * does not outlive the review that referenced it.
     */
    private fun clearPendingTorrent(deleteFile: Boolean = true) {
        val path = savedState.get<String>(KEY_PENDING_TORRENT_PATH)
        if (deleteFile && path != null) {
            viewModelScope.launch(Dispatchers.IO) {
                PendingTorrentStore.delete(path)
            }
        }
        savedState.remove<String>(KEY_PENDING_TORRENT_PATH)
        savedState.remove<String>(KEY_PENDING_TORRENT_FILENAME)
        savedState.remove<Boolean>(KEY_PENDING_PAUSED)
    }

    private fun clearPasteDraft() {
        savedState.remove<String>(KEY_PASTE_DRAFT)
        savedState.remove<String>(KEY_PASTE_ERROR)
    }

    /** Ask the proxy about itself and its qBittorrent link. */
    fun testConnection() {
        val current = _state.value
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(checkingProxy = false, proxyStatus = ProxyStatus.NotConfigured)
            }
            return
        }

        val checkId = ++proxyCheckId
        val settings = current.settings
        _state.update { it.copy(checkingProxy = true, proxyStatus = null) }
        viewModelScope.launch {
            val status = proxyHealth.check(settings)
            if (checkId == proxyCheckId) {
                _state.update { it.copy(checkingProxy = false, proxyStatus = status) }
            }
        }
    }

    fun clearNotice() {
        _state.update { it.copy(notice = null) }
    }

    private companion object {
        const val KEY_PENDING_MAGNET = "pending-magnet"
        const val KEY_PENDING_PAUSED = "pending-magnet-paused"
        const val KEY_PENDING_TORRENT_PATH = "pending-torrent-path"
        const val KEY_PENDING_TORRENT_FILENAME = "pending-torrent-filename"
        const val KEY_PASTE_DRAFT = "pending-magnet-draft"
        const val KEY_PASTE_ERROR = "pending-magnet-error"

        const val STAGED_TORRENT_MISSING =
            "The selected .torrent file is no longer available. Choose it again."

        const val POLL_INTERVAL_MS = 5_000L
    }
}
