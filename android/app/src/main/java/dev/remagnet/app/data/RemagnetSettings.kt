package dev.remagnet.app.data

import java.net.URI
import java.net.URISyntaxException

const val MIN_PROXY_TOKEN_LENGTH = 16

/**
 * Everything the app needs to reach the Remagnet Proxy.
 *
 * qBittorrent credentials never reach the phone: the proxy owns that connection
 * and the app authenticates to the proxy with a single bearer token. This is
 * the in-memory shape; [SettingsRepository] keeps the token encrypted.
 */
data class RemagnetSettings(
    val proxyBaseUrl: String = "",
    val proxyToken: String = "",
) {
    /** Both fields are required before any request can be made. */
    val proxyConfigured: Boolean
        get() = proxyBaseUrl.isNotBlank() && proxyToken.isNotBlank()

    /** Trim the values users type into forms and drop trailing slashes. */
    fun normalized(): RemagnetSettings = copy(
        proxyBaseUrl = normalizeBaseUrl(proxyBaseUrl),
        proxyToken = proxyToken.trim(),
    )

    /** True when a completed torrent can be downloaded through the proxy. */
    val archiveReady: Boolean
        get() = proxyConfigured && validate().isEmpty()

    /** Validate this snapshot, returning one error per unusable field. */
    fun validate(): List<SettingsError> = validateSettings(this)
}

/** Fields that can carry a validation message, in screen order. */
enum class SettingsField {
    ProxyUrl,
    ProxyToken,
}

data class SettingsError(val field: SettingsField, val message: String)

/**
 * Validate a settings snapshot. The proxy is the only connection the app has,
 * so both the URL and the token are required.
 */
fun validateSettings(settings: RemagnetSettings): List<SettingsError> {
    val values = settings.normalized()
    val errors = mutableListOf<SettingsError>()

    if (parseHttpUrl(values.proxyBaseUrl) == null) {
        errors += SettingsError(
            SettingsField.ProxyUrl,
            "Enter a valid http:// or https:// Remagnet Proxy URL without credentials, a query or a fragment.",
        )
    }
    if (values.proxyToken.isBlank()) {
        errors += SettingsError(
            SettingsField.ProxyToken,
            "Enter the Remagnet Proxy token.",
        )
    } else if (values.proxyToken.length < MIN_PROXY_TOKEN_LENGTH) {
        errors += SettingsError(
            SettingsField.ProxyToken,
            "The Remagnet Proxy token must be at least $MIN_PROXY_TOKEN_LENGTH characters.",
        )
    }

    return errors
}

/**
 * Validate only the proxy fields. Kept as a name because the download service
 * and health check describe their subset of the connection this way; both
 * fields are now mandatory, so this is the full validation.
 */
fun validateProxySettings(settings: RemagnetSettings): List<SettingsError> = validateSettings(settings)

/** Trim and drop trailing slashes. */
fun normalizeBaseUrl(value: String): String = value.trim().trimEnd('/')

/**
 * Parse an HTTP(S) URL and reject the parts that would hide a second source of
 * truth: embedded credentials, a query or a fragment.
 */
internal fun parseHttpUrl(value: String): URI? {
    if (value.isBlank()) return null
    return try {
        val uri = URI(value.trim())
        val scheme = uri.scheme?.lowercase()
        when {
            scheme != "http" && scheme != "https" -> null
            uri.host.isNullOrBlank() -> null
            uri.userInfo != null -> null
            uri.rawQuery != null || uri.rawFragment != null -> null
            else -> uri
        }
    } catch (_: URISyntaxException) {
        null
    }
}
