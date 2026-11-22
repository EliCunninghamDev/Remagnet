package dev.remagnet.app.data

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.URLDecoder

/**
 * A connection package that can be scanned from a QR code.
 *
 * The documented form is:
 *
 * `remagnet://connect?qbit=https://qbt.example.com&apiKey=...&proxy=https://remagnet.example.com&token=...`
 *
 * A JSON object with the same names is also accepted so a generated code can be
 * produced without URL-encoding every secret. A bare `http(s)` URL is treated as
 * a proxy URL, which is useful for a minimal hand-written code.
 */
data class OnboardingPayload(
    val qbitBaseUrl: String? = null,
    val authMode: AuthMode? = null,
    val qbitApiKey: String? = null,
    val qbitUsername: String? = null,
    val qbitPassword: String? = null,
    val defaultCategory: String? = null,
    val defaultTags: String? = null,
    val proxyBaseUrl: String? = null,
    val proxyToken: String? = null,
) {
    val hasQbitValues: Boolean
        get() = qbitBaseUrl != null ||
            qbitApiKey != null ||
            qbitUsername != null ||
            qbitPassword != null ||
            defaultCategory != null ||
            defaultTags != null

    val hasProxyValues: Boolean
        get() = proxyBaseUrl != null || proxyToken != null

    /** Merge the package over the current settings, leaving absent fields alone. */
    fun applyTo(current: RemagnetSettings): RemagnetSettings {
        val inferredAuth = authMode ?: when {
            qbitApiKey != null -> AuthMode.ApiKey
            qbitUsername != null || qbitPassword != null -> AuthMode.Password
            else -> current.authMode
        }
        return current.copy(
            qbitBaseUrl = qbitBaseUrl ?: current.qbitBaseUrl,
            authMode = inferredAuth,
            qbitApiKey = qbitApiKey ?: current.qbitApiKey,
            qbitUsername = qbitUsername ?: current.qbitUsername,
            qbitPassword = qbitPassword ?: current.qbitPassword,
            defaultCategory = defaultCategory ?: current.defaultCategory,
            defaultTags = defaultTags ?: current.defaultTags,
            proxyBaseUrl = proxyBaseUrl ?: current.proxyBaseUrl,
            proxyToken = proxyToken ?: current.proxyToken,
        )
    }
}

sealed interface OnboardingResult {
    data class Parsed(val payload: OnboardingPayload) : OnboardingResult

    data class Invalid(val message: String) : OnboardingResult
}

fun parseOnboarding(text: String): OnboardingResult {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return OnboardingResult.Invalid("The code is empty.")

    return when {
        trimmed.startsWith("{") -> parseJson(trimmed)
        trimmed.startsWith("remagnet:", ignoreCase = true) -> parseConnectUri(trimmed)
        trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true) ->
            OnboardingResult.Parsed(OnboardingPayload(proxyBaseUrl = trimmed))

        else -> OnboardingResult.Invalid(
            "This is not a Remagnet connect code. Expected a remagnet:// link or JSON.",
        )
    }
}

private fun parseConnectUri(text: String): OnboardingResult {
    val uri: URI = try {
        URI(text)
    } catch (_: Exception) {
        return OnboardingResult.Invalid("The connect link is not a valid URI.")
    }

    if (!uri.scheme.equals("remagnet", ignoreCase = true)) {
        return OnboardingResult.Invalid("The connect link must use the remagnet:// scheme.")
    }
    if (!uri.host.equals("connect", ignoreCase = true)) {
        return OnboardingResult.Invalid("The connect link must point at remagnet://connect.")
    }

    return fromValues(parseQuery(uri.rawQuery))
}

private fun parseJson(text: String): OnboardingResult {
    val json = try {
        JsonParser.parseString(text).asJsonObject
    } catch (_: Exception) {
        return OnboardingResult.Invalid("The JSON code could not be read.")
    }
    return fromValues(json.toStringMap())
}

private fun fromValues(values: Map<String, String>): OnboardingResult {
    fun value(vararg keys: String): String? = keys.firstNotNullOfOrNull { key ->
        values[key]?.takeIf { it.isNotBlank() }
    }

    // Tokens and keys are trimmed, passwords are not: whitespace can be part of
    // a real password, and changing it would produce a confusing auth failure.
    val apiKey = value("apiKey", "qbitApiKey", "key")?.trim()
    val username = value("username", "qbitUsername", "user")?.trim()
    val password = value("password", "qbitPassword", "pass")
    val explicitAuth = value("auth", "authMode")?.let { parseAuthMode(it) }
    val inferredAuth = explicitAuth ?: when {
        apiKey != null -> AuthMode.ApiKey
        username != null || password != null -> AuthMode.Password
        else -> null
    }

    val payload = OnboardingPayload(
        qbitBaseUrl = value("qbit", "qbitUrl", "qbitBaseUrl", "qbittorrent")?.trim(),
        authMode = inferredAuth,
        qbitApiKey = apiKey,
        qbitUsername = username,
        qbitPassword = password,
        defaultCategory = value("category", "defaultCategory")?.trim(),
        defaultTags = value("tags", "defaultTags")?.trim(),
        proxyBaseUrl = value("proxy", "proxyUrl", "archive", "archiveUrl", "url")?.trim(),
        proxyToken = value("token", "proxyToken", "archiveToken")?.trim(),
    )

    if (!payload.hasQbitValues && !payload.hasProxyValues) {
        return OnboardingResult.Invalid(
            "The code does not contain any Remagnet connection settings.",
        )
    }
    return OnboardingResult.Parsed(payload)
}

private fun parseAuthMode(value: String): AuthMode? = when (value.trim().lowercase()) {
    "apikey", "api_key", "key" -> AuthMode.ApiKey
    "password", "userpass", "username" -> AuthMode.Password
    else -> null
}

private fun parseQuery(rawQuery: String?): Map<String, String> {
    if (rawQuery.isNullOrEmpty()) return emptyMap()
    return rawQuery
        .split('&')
        .filter { it.isNotEmpty() }
        .mapNotNull { pair ->
            val separator = pair.indexOf('=')
            if (separator <= 0) {
                null
            } else {
                decodeQuery(pair.substring(0, separator)) to
                    decodeQuery(pair.substring(separator + 1))
            }
        }
        .toMap()
}

/**
 * Query values follow URL encoding except that `+` stays a plus. Base64
 * tokens commonly contain `+`, and forms rarely put spaces in these fields;
 * encoded spaces arrive as `%20`.
 */
private fun decodeQuery(value: String): String = runCatching {
    // The String overload is available on API 26; the Charset overload is not.
    URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
}.getOrDefault(value)

private fun JsonObject.toStringMap(): Map<String, String> = buildMap {
    for ((key, element) in entrySet()) {
        if (element.isJsonPrimitive && element.asJsonPrimitive.isString) {
            put(key, element.asString)
        }
    }
}
