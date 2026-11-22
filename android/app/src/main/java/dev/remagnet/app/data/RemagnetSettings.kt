package dev.remagnet.app.data

import java.net.URI
import java.net.URISyntaxException

/** Authentication styles supported by the qBittorrent adapter. */
enum class AuthMode(val storageValue: String) {
    ApiKey("apiKey"),
    Password("password"),
    ;

    companion object {
        fun fromStorage(value: String?): AuthMode =
            entries.firstOrNull { it.storageValue == value } ?: ApiKey
    }
}

const val DEFAULT_QBIT_BASE_URL = "http://127.0.0.1:8080"
const val DEFAULT_CATEGORY = "remagnet"
const val DEFAULT_TAGS = "remagnet"
const val MIN_PROXY_TOKEN_LENGTH = 16

/**
 * Everything the app needs to reach qBittorrent and the optional proxy.
 *
 * This is the in-memory shape. [SettingsRepository] keeps the three secrets
 * encrypted and everything else readable.
 */
data class RemagnetSettings(
    val qbitBaseUrl: String = DEFAULT_QBIT_BASE_URL,
    val authMode: AuthMode = AuthMode.ApiKey,
    val qbitApiKey: String = "",
    val qbitUsername: String = "admin",
    val qbitPassword: String = "",
    val defaultCategory: String = DEFAULT_CATEGORY,
    val defaultTags: String = DEFAULT_TAGS,
    val proxyBaseUrl: String = "",
    val proxyToken: String = "",
) {
    /** A client connection is only useful once a credential is present. */
    val qbitConfigured: Boolean
        get() = when (authMode) {
            AuthMode.ApiKey -> qbitBaseUrl.isNotBlank() && qbitApiKey.isNotBlank()
            AuthMode.Password ->
                qbitBaseUrl.isNotBlank() &&
                    qbitUsername.isNotBlank() &&
                    qbitPassword.isNotEmpty()
        }

    /** The proxy is optional; both fields blank means the feature is off. */
    val proxyConfigured: Boolean
        get() = proxyBaseUrl.isNotBlank() && proxyToken.isNotBlank()

    /**
     * Trim the values users type into forms, without touching the password:
     * leading and trailing spaces can be part of a real password.
     */
    fun normalized(): RemagnetSettings = copy(
        qbitBaseUrl = normalizeBaseUrl(qbitBaseUrl),
        qbitApiKey = qbitApiKey.trim(),
        qbitUsername = qbitUsername.trim(),
        defaultCategory = defaultCategory.trim(),
        defaultTags = normalizeTags(defaultTags),
        proxyBaseUrl = normalizeBaseUrl(proxyBaseUrl),
        proxyToken = proxyToken.trim(),
    )

    /** True when a completed torrent can be downloaded through the proxy. */
    val archiveReady: Boolean
        get() = proxyConfigured && validateSettings(this).isEmpty()
}

/** Fields that can carry a validation message, in screen order. */
enum class SettingsField {
    QbitUrl,
    QbitApiKey,
    QbitUsername,
    QbitPassword,
    ProxyUrl,
    ProxyToken,
}

data class SettingsError(val field: SettingsField, val message: String)

/**
 * Validate a settings snapshot. The proxy is optional, but half-configuring it
 * is not: an empty URL with a saved token would silently disable downloads.
 */
fun validateSettings(settings: RemagnetSettings): List<SettingsError> {
    val values = settings.normalized()
    val errors = mutableListOf<SettingsError>()

    if (parseHttpUrl(values.qbitBaseUrl) == null) {
        errors += SettingsError(
            SettingsField.QbitUrl,
            "Enter a valid http:// or https:// Web UI URL without credentials, a query or a fragment.",
        )
    }

    when (values.authMode) {
        AuthMode.ApiKey -> if (values.qbitApiKey.isBlank()) {
            errors += SettingsError(
                SettingsField.QbitApiKey,
                "Enter an API key, or switch to username & password.",
            )
        }

        AuthMode.Password -> {
            if (values.qbitUsername.isBlank()) {
                errors += SettingsError(
                    SettingsField.QbitUsername,
                    "Enter a username, or switch to an API key.",
                )
            }
            if (values.qbitPassword.isEmpty()) {
                errors += SettingsError(
                    SettingsField.QbitPassword,
                    "Enter a password, or switch to an API key.",
                )
            }
        }
    }

    errors += validateProxySettings(values)
    return errors
}

/**
 * Validate only the optional proxy fields. Health checks use this so an
 * unconfigured torrent client cannot hide a perfectly good proxy result.
 */
fun validateProxySettings(settings: RemagnetSettings): List<SettingsError> {
    val values = settings.normalized()
    val errors = mutableListOf<SettingsError>()
    val hasProxyUrl = values.proxyBaseUrl.isNotEmpty()
    val hasProxyToken = values.proxyToken.isNotEmpty()

    if (hasProxyUrl != hasProxyToken) {
        errors += if (hasProxyUrl) {
            SettingsError(
                SettingsField.ProxyToken,
                "Enter the proxy token, or clear the proxy URL.",
            )
        } else {
            SettingsError(
                SettingsField.ProxyUrl,
                "Enter the proxy URL, or clear the proxy token.",
            )
        }
    } else if (hasProxyUrl) {
        if (parseHttpUrl(values.proxyBaseUrl) == null) {
            errors += SettingsError(
                SettingsField.ProxyUrl,
                "Enter a valid http:// or https:// proxy URL without credentials, a query or a fragment.",
            )
        }
        if (values.proxyToken.length < MIN_PROXY_TOKEN_LENGTH) {
            errors += SettingsError(
                SettingsField.ProxyToken,
                "The proxy token must be at least $MIN_PROXY_TOKEN_LENGTH characters.",
            )
        }
    }

    return errors
}

/** Trim, drop trailing slashes and leave an unusable value as typed. */
fun normalizeBaseUrl(value: String): String = value.trim().trimEnd('/')

/** Collapse `a, b,, a` into `a, b` so repeated saves stay stable. */
fun normalizeTags(value: String): String = value
    .split(',')
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .distinct()
    .joinToString(", ")

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
