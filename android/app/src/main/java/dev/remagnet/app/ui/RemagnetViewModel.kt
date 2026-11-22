package dev.remagnet.app.ui

import android.app.Application
import android.app.NotificationManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import dev.remagnet.app.client.QBittorrentClient
import dev.remagnet.app.client.QbitError
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.PairingClaim
import dev.remagnet.app.client.PairingClient
import dev.remagnet.app.client.ProxyHealthClient
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.client.TorrentClient
import dev.remagnet.app.client.TorrentSummary
import dev.remagnet.app.client.filterTorrents
import dev.remagnet.app.client.torrentFilterFor
import dev.remagnet.app.data.AuthMode
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
import dev.remagnet.app.magnet.MagnetLink
import dev.remagnet.app.magnet.NO_HASH_MESSAGE
import dev.remagnet.app.magnet.isMagnetLink
import dev.remagnet.app.magnet.magnetFromText
import dev.remagnet.app.magnet.magnetLabel
import dev.remagnet.app.magnet.parseMagnet
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
    val checking: Boolean = false,
    val proxyStatus: ProxyStatus? = null,
    val checkingQbit: Boolean = false,
    val qbitStatus: QbitStatus? = null,
    val torrents: List<TorrentSummary> = emptyList(),
    val torrentsLoading: Boolean = false,
    val torrentsError: String? = null,
    val confirmingHash: String? = null,
    val removingHash: String? = null,
    val actionError: String? = null,
    val download: ArchiveDownloadState = ArchiveDownloadState.Idle,
    val addSheet: AddSheetState = AddSheetState.Closed,
    val notice: String? = null,
    val pairing: PairingState = PairingState.Idle,
)

/** What a direct qBittorrent check found, independent of the optional proxy. */
sealed interface QbitStatus {
    data object NotConfigured : QbitStatus

    data object Checking : QbitStatus

    data class Online(
        val appVersion: String,
        val webApiVersion: String,
        val authMode: AuthMode,
    ) : QbitStatus

    data class Unauthorized(val message: String) : QbitStatus

    data class Unreachable(val message: String) : QbitStatus

    data class Error(val message: String) : QbitStatus
}

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

    /** Claimed settings, not saved yet; the settings screen reviews them. */
    data class Paired(val settings: RemagnetSettings) : PairingState
}

class RemagnetViewModel(
    application: Application,
    private val repository: SettingsRepository,
    private val proxyHealth: ProxyHealthClient,
    private val clientFactory: (RemagnetSettings) -> TorrentClient,
    private val savedState: SavedStateHandle,
    private val pairingClient: PairingClient = PairingClient(),
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
        clientFactory = { settings -> QBittorrentClient.from(settings) },
        savedState = savedState,
    )

    private val _state = MutableStateFlow(RemagnetUiState())
    val state: StateFlow<RemagnetUiState> = _state.asStateFlow()

    /** Let a newer request win when settings or the magnet change mid-flight. */
    private var qbitCheckId = 0
    private var proxyCheckId = 0
    private var addLookupId = 0
    private var addSubmitId = 0
    private var listRequestId = 0
    private var pollJob: Job? = null
    private var lastDownloadPath: String? = null

    init {
        val settings = repository.load()
        _state.value = RemagnetUiState(settings = settings, loaded = true)
        if (settings.qbitConfigured) checkQbitConnection()
        if (settings.proxyConfigured) checkConnection()

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

        val pendingMagnet = savedState.get<String>(KEY_PENDING_MAGNET)
        if (pendingMagnet != null) {
            openMagnet(
                uri = pendingMagnet,
                restorePaused = savedState.get<Boolean>(KEY_PENDING_PAUSED) ?: false,
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

        val result = withContext(Dispatchers.IO) {
            try {
                SaveResult.Saved(repository.save(normalized))
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
                    qbitStatus = null,
                    notice = "Settings saved.",
                    torrents = if (result.settings.qbitConfigured) it.torrents else emptyList(),
                    torrentsError = null,
                )
            }
            if (result.settings.qbitConfigured) {
                checkQbitConnection()
                refreshTorrents()
                startPolling()
            } else {
                stopPolling()
            }
            if (result.settings.proxyConfigured) checkConnection()
        }
        return result
    }

    // ---- Mobile pairing ---------------------------------------------------

    /**
     * Claim a scanned code. The result is presented as form values, not saved:
     * the user still reviews and confirms them on the settings screen.
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
                    val connection = result.connection
                    val current = _state.value.settings
                    val paired = current.copy(
                        qbitBaseUrl = connection.qbitBaseUrl,
                        authMode = connection.authMode,
                        qbitApiKey = connection.apiKey ?: current.qbitApiKey,
                        qbitUsername = connection.username ?: current.qbitUsername,
                        qbitPassword = connection.password ?: current.qbitPassword,
                        proxyBaseUrl = link.proxyBaseUrl,
                        proxyToken = connection.proxyToken,
                    ).normalized()
                    _state.update { it.copy(pairing = PairingState.Paired(paired)) }
                }
            }
        }
    }

    fun clearPairing() {
        _state.update { it.copy(pairing = PairingState.Idle) }
    }

    // ---- Torrent list -----------------------------------------------------

    /**
     * Refresh while the home screen is visible. The poller is cancelled on
     * pause, so a backgrounded Remagnet does not keep talking to qBittorrent.
     */
    fun startPolling() {
        if (!_state.value.settings.qbitConfigured) return
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
        if (!_state.value.settings.qbitConfigured) return
        viewModelScope.launch { loadTorrents(showLoading = true) }
    }

    private suspend fun loadTorrents(showLoading: Boolean) {
        val settings = _state.value.settings
        if (!settings.qbitConfigured) {
            listRequestId += 1
            _state.update {
                it.copy(torrents = emptyList(), torrentsLoading = false, torrentsError = null)
            }
            return
        }

        val requestId = ++listRequestId
        if (showLoading) _state.update { it.copy(torrentsLoading = true) }

        val result = clientFactory(settings).listTorrents()
        // A poll cancelled by leaving the screen can surface as a generic
        // client error; it is not a connection problem the user should see.
        if (requestId != listRequestId || !currentCoroutineContext().isActive) return

        when (result) {
            is QbitResult.Success -> {
                val filter = torrentFilterFor(settings)
                _state.update {
                    it.copy(
                        torrents = filterTorrents(result.value, filter),
                        torrentsLoading = false,
                        torrentsError = null,
                    )
                }
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
        if (!current.settings.qbitConfigured) {
            _state.update {
                it.copy(
                    actionError = "qBittorrent is not configured.",
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

    fun cancelDownload() {
        if (!ArchiveDownloads.isActive()) return
        ArchiveDownloadService.cancel(getApplication())
    }

    fun dismissDownload() {
        ArchiveDownloads.dismiss()
        getApplication<Application>().getSystemService(NotificationManager::class.java)
            ?.cancel(ArchiveDownloadService.NOTIFICATION_ID)
    }

    /** Open the sheet without a magnet so one can be pasted or shared. */
    fun openAddSheet() {
        addLookupId += 1
        addSubmitId += 1
        clearPendingMagnet()
        clearPasteDraft()
        _state.update { it.copy(addSheet = AddSheetState.Paste()) }
    }

    /**
     * Accept a `VIEW magnet:` or `SEND` payload. An unusable link still opens
     * the sheet with the draft intact, so a malformed share can be corrected.
     */
    fun acceptIntake(intake: MagnetIntake) {
        when (intake) {
            is MagnetIntake.Magnet -> openMagnet(intake.uri)
            is MagnetIntake.Unusable -> openPaste(intake.draft, intake.message)
            MagnetIntake.None -> Unit
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
        updateReview(review.magnet.uri) { it.copy(paused = paused) }
    }

    /** Return to the paste form with the current link so it can be corrected. */
    fun editReviewedMagnet() {
        val review = _state.value.addSheet as? AddSheetState.Review ?: return
        if (review.submitting) return
        openPaste(review.magnet.uri, error = null)
    }

    fun retryDuplicateCheck() {
        val review = _state.value.addSheet as? AddSheetState.Review ?: return
        if (review.submitting) return
        updateReview(review.magnet.uri) {
            it.copy(duplicate = DuplicateState.Checking, error = null)
        }
        checkDuplicate(review.magnet)
    }

    fun submitMagnet() {
        val current = _state.value
        val review = current.addSheet as? AddSheetState.Review ?: return
        if (!review.canSubmit) return

        if (!current.settings.qbitConfigured) {
            updateReview(review.magnet.uri) {
                it.copy(duplicate = DuplicateState.NotConfigured)
            }
            return
        }

        val submitId = ++addSubmitId
        val settings = current.settings
        val magnet = review.magnet
        val request = addRequestFor(settings, magnet, review.paused)
        updateReview(magnet.uri) { it.copy(submitting = true, error = null) }

        viewModelScope.launch {
            val result = clientFactory(settings).addTorrent(request)
            if (submitId != addSubmitId) return@launch

            when (result) {
                is QbitResult.Success -> {
                    val name = magnetLabel(magnet)
                    clearPendingMagnet()
                    _state.update {
                        it.copy(
                            addSheet = AddSheetState.Added(
                                name = name,
                                category = request.category,
                                tags = request.tags,
                            ),
                            notice = "Added \"$name\" to qBittorrent.",
                        )
                    }
                    refreshTorrents()
                }

                is QbitResult.Failure -> {
                    updateReview(magnet.uri) {
                        it.copy(submitting = false, error = result.error.message)
                    }
                    // qBittorrent rejects a duplicate even when the lookup said
                    // the hash was clear, for example if another client added
                    // it first. Re-check so the sheet explains why.
                    if (result.error is QbitError.Rejected) checkDuplicate(magnet)
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
        clearPasteDraft()
        _state.update { it.copy(addSheet = AddSheetState.Closed) }
    }

    private fun openMagnet(uri: String, restorePaused: Boolean? = null) {
        val link = parseMagnet(uri)
        if (link?.infoHash == null) {
            openPaste(link?.uri ?: uri, NO_HASH_MESSAGE)
            return
        }

        // Activity recreation can deliver the same intent that is already
        // restored from saved state. Do not restart the lookup for it.
        val current = _state.value.addSheet
        if (current is AddSheetState.Review && current.magnet.uri == link.uri) return

        val paused = restorePaused
            ?: (current as? AddSheetState.Review)?.paused
            ?: false
        clearPasteDraft()
        savedState[KEY_PENDING_MAGNET] = link.uri
        savedState[KEY_PENDING_PAUSED] = paused
        addLookupId += 1
        addSubmitId += 1
        _state.update {
            it.copy(
                addSheet = AddSheetState.Review(
                    magnet = link,
                    paused = paused,
                    duplicate = DuplicateState.Checking,
                ),
            )
        }
        checkDuplicate(link)
    }

    private fun openPaste(draft: String, error: String?) {
        addLookupId += 1
        addSubmitId += 1
        clearPendingMagnet()
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

    private fun checkDuplicate(magnet: MagnetLink) {
        val hash = magnet.infoHash ?: return

        if (!_state.value.settings.qbitConfigured) {
            updateReview(magnet.uri) {
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
            updateReview(magnet.uri) { it.copy(duplicate = duplicate) }
        }
    }

    private fun updateReview(
        uri: String,
        transform: (AddSheetState.Review) -> AddSheetState.Review,
    ) {
        _state.update { current ->
            val sheet = current.addSheet
            if (sheet is AddSheetState.Review && sheet.magnet.uri == uri) {
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

    private fun clearPasteDraft() {
        savedState.remove<String>(KEY_PASTE_DRAFT)
        savedState.remove<String>(KEY_PASTE_ERROR)
    }

    /** Ask qBittorrent directly for its version, without involving the proxy. */
    fun checkQbitConnection() {
        val current = _state.value
        if (!current.settings.qbitConfigured) {
            _state.update {
                it.copy(checkingQbit = false, qbitStatus = QbitStatus.NotConfigured)
            }
            return
        }

        val checkId = ++qbitCheckId
        val settings = current.settings
        _state.update { it.copy(checkingQbit = true, qbitStatus = QbitStatus.Checking) }
        viewModelScope.launch {
            val status = when (val result = clientFactory(settings).testConnection()) {
                is QbitResult.Success -> QbitStatus.Online(
                    appVersion = result.value.appVersion,
                    webApiVersion = result.value.webApiVersion,
                    authMode = settings.authMode,
                )

                is QbitResult.Failure -> result.error.toQbitStatus()
            }
            if (checkId == qbitCheckId) {
                _state.update { it.copy(checkingQbit = false, qbitStatus = status) }
            }
        }
    }

    /** Ask the proxy about itself and its qBittorrent link. */
    fun checkConnection() {
        val current = _state.value
        if (!current.settings.proxyConfigured) {
            _state.update {
                it.copy(checking = false, proxyStatus = ProxyStatus.NotConfigured)
            }
            return
        }

        val checkId = ++proxyCheckId
        val settings = current.settings
        _state.update { it.copy(checking = true, proxyStatus = null) }
        viewModelScope.launch {
            val status = proxyHealth.check(settings)
            if (checkId == proxyCheckId) {
                _state.update { it.copy(checking = false, proxyStatus = status) }
            }
        }
    }

    fun clearNotice() {
        _state.update { it.copy(notice = null) }
    }

    private fun QbitError.toQbitStatus(): QbitStatus = when (this) {
        is QbitError.Unauthorized -> QbitStatus.Unauthorized(message)
        is QbitError.Unreachable -> QbitStatus.Unreachable(message)
        is QbitError.InvalidSettings -> QbitStatus.Error(message)
        is QbitError.Http -> QbitStatus.Error(message)
        is QbitError.Rejected -> QbitStatus.Error(message)
        is QbitError.InvalidResponse -> QbitStatus.Error(message)
    }

    private companion object {
        const val KEY_PENDING_MAGNET = "pending-magnet"
        const val KEY_PENDING_PAUSED = "pending-magnet-paused"
        const val KEY_PASTE_DRAFT = "pending-magnet-draft"
        const val KEY_PASTE_ERROR = "pending-magnet-error"

        const val POLL_INTERVAL_MS = 5_000L
    }
}
