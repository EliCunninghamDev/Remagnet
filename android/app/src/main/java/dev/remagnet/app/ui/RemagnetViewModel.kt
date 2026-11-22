package dev.remagnet.app.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.remagnet.app.client.QBittorrentClient
import dev.remagnet.app.client.QbitError
import dev.remagnet.app.client.QbitResult
import dev.remagnet.app.client.ProxyHealthClient
import dev.remagnet.app.client.ProxyStatus
import dev.remagnet.app.client.TorrentClient
import dev.remagnet.app.data.AuthMode
import dev.remagnet.app.data.KeystoreSecretCipher
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.SettingsError
import dev.remagnet.app.data.SettingsRepository
import dev.remagnet.app.data.SharedPreferencesStore
import dev.remagnet.app.data.validateSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class RemagnetUiState(
    val settings: RemagnetSettings = RemagnetSettings(),
    val loaded: Boolean = false,
    val checking: Boolean = false,
    val proxyStatus: ProxyStatus? = null,
    val checkingQbit: Boolean = false,
    val qbitStatus: QbitStatus? = null,
    val notice: String? = null,
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

class RemagnetViewModel @JvmOverloads constructor(
    application: Application,
    private val repository: SettingsRepository = defaultRepository(application),
    private val proxyHealth: ProxyHealthClient = ProxyHealthClient(),
    private val clientFactory: (RemagnetSettings) -> TorrentClient = { settings ->
        QBittorrentClient.from(settings)
    },
) : AndroidViewModel(application) {
    private val _state = MutableStateFlow(RemagnetUiState())
    val state: StateFlow<RemagnetUiState> = _state.asStateFlow()

    /** Lets a newer check win when settings change while one is in flight. */
    private var qbitCheckId = 0

    init {
        val settings = repository.load()
        _state.value = RemagnetUiState(settings = settings, loaded = true)
        if (settings.qbitConfigured) checkQbitConnection()
        if (settings.proxyConfigured) checkConnection()
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
            _state.update {
                it.copy(
                    settings = result.settings,
                    proxyStatus = null,
                    qbitStatus = null,
                    notice = "Settings saved.",
                )
            }
            if (result.settings.qbitConfigured) checkQbitConnection()
            if (result.settings.proxyConfigured) checkConnection()
        }
        return result
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
        if (current.checking || !current.settings.proxyConfigured) return

        _state.update { it.copy(checking = true, proxyStatus = null) }
        viewModelScope.launch {
            val status = proxyHealth.check(_state.value.settings)
            _state.update { it.copy(checking = false, proxyStatus = status) }
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
        fun defaultRepository(application: Application): SettingsRepository {
            val preferences = application.getSharedPreferences(
                "remagnet.settings",
                Context.MODE_PRIVATE,
            )
            return SettingsRepository(
                store = SharedPreferencesStore(preferences),
                cipher = KeystoreSecretCipher(),
            )
        }
    }
}
