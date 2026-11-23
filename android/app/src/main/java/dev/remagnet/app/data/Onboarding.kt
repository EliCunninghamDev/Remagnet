package dev.remagnet.app.data

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.URLDecoder

/**
 * A connection package that can be scanned from a QR code.
 *
 * The primary form is a `remagnet://pair` link. The documented fallbacks are:
 *
 * `remagnet://connect?proxy=https://remagnet.example.com&token=...`
 *
 * a JSON object with `proxy` and `token`, or a bare `http(s)` URL treated as
 * the proxy. qBittorrent credentials never travel to the phone.
 */
data class OnboardingPayload(
    val proxyBaseUrl: String? = null,
    val proxyToken: String? = null,
) {
    val hasProxyValues: Boolean
        get() = proxyBaseUrl != null || proxyToken != null

    /** Merge the package over the current settings, leaving absent fields alone. */
    fun applyTo(current: RemagnetSettings): RemagnetSettings = current.copy(
        proxyBaseUrl = proxyBaseUrl ?: current.proxyBaseUrl,
        proxyToken = proxyToken ?: current.proxyToken,
    )
}

sealed interface OnboardingResult {
    data class Parsed(val payload: OnboardingPayload) : OnboardingResult

    /** A short-lived code that must be claimed from the proxy. */
    data class Pairing(val link: PairingLink) : OnboardingResult

    data class Invalid(val message: String) : OnboardingResult
}

/**
 * The payload of a `remagnet://pair` QR code.
 *
 * The proxy URL travels with the code, so the phone never asks the user to
 * type it. The id names the short-lived in-memory session on the proxy and the
 * code is the secret that both finds and decrypts the response.
 */
data class PairingLink(
    val proxyBaseUrl: String,
    val id: String,
    val code: String,
)

fun parseOnboarding(text: String): OnboardingResult {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return OnboardingResult.Invalid("The code is empty.")

    return when {
        trimmed.startsWith("{") -> parseJson(trimmed)
        trimmed.startsWith("remagnet:", ignoreCase = true) -> parseRemagnetUri(trimmed)
        trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true) ->
            OnboardingResult.Parsed(
                OnboardingPayload(proxyBaseUrl = normalizeBaseUrl(trimmed)),
            )

        else -> OnboardingResult.Invalid(
            "This is not a Remagnet code. Expected a remagnet://pair link, a remagnet://connect link, JSON, or a proxy URL.",
        )
    }
}

private fun parseRemagnetUri(text: String): OnboardingResult {
    val uri: URI = try {
        URI(text)
    } catch (_: Exception) {
        return OnboardingResult.Invalid("The Remagnet link is not a valid URI.")
    }

    if (!uri.scheme.equals("remagnet", ignoreCase = true)) {
        return OnboardingResult.Invalid("The link must use the remagnet:// scheme.")
    }

    return when {
        uri.host.equals("pair", ignoreCase = true) -> fromPairingValues(parseQuery(uri.rawQuery))
        uri.host.equals("connect", ignoreCase = true) -> fromValues(parseQuery(uri.rawQuery))
        else -> OnboardingResult.Invalid(
            "The link must point at remagnet://pair or remagnet://connect.",
        )
    }
}

private fun fromPairingValues(values: Map<String, String>): OnboardingResult {
    fun value(vararg keys: String): String? = keys.firstNotNullOfOrNull { key ->
        values[key]?.takeIf { it.isNotBlank() }
    }

    val proxy = value("url", "proxy", "proxyUrl")?.trim()?.trimEnd('/')
    val id = value("id")?.trim()
    val code = value("code", "pairingCode")?.trim()

    if (proxy.isNullOrEmpty() || id.isNullOrEmpty() || code.isNullOrEmpty()) {
        return OnboardingResult.Invalid("The pairing code is incomplete. Show a new code and scan it again.")
    }

    val uri = try {
        URI(proxy)
    } catch (_: Exception) {
        return OnboardingResult.Invalid("The pairing code does not contain a valid proxy URL.")
    }
    if (!uri.scheme.equals("http", ignoreCase = true) &&
        !uri.scheme.equals("https", ignoreCase = true)
    ) {
        return OnboardingResult.Invalid("The pairing proxy URL must use http:// or https://.")
    }
    if (uri.host.isNullOrEmpty()) {
        return OnboardingResult.Invalid("The pairing proxy URL needs a host.")
    }
    if (uri.userInfo != null) {
        return OnboardingResult.Invalid("The pairing proxy URL must not contain credentials.")
    }
    // The pairing response carries the proxy token, so a non-loopback plain
    // HTTP origin would let anyone on the path read it despite the inner
    // encryption. The Android network security config also blocks cleartext.
    val host = uri.host.lowercase()
    val loopback = host == "127.0.0.1" || host == "localhost" ||
        host == "::1" || host == "[::1]" || host == "10.0.2.2"
    if (!uri.scheme.equals("https", ignoreCase = true) && !loopback) {
        return OnboardingResult.Invalid(
            "Pairing needs an HTTPS Remagnet Proxy URL. Put the proxy behind HTTPS and try again.",
        )
    }

    return OnboardingResult.Pairing(
        PairingLink(proxyBaseUrl = proxy, id = id, code = code),
    )
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

    val proxy = value("proxy", "proxyUrl", "url")?.trim()?.trimEnd('/')
    val token = value("token", "proxyToken")?.trim()

    if (proxy == null && token == null) {
        return OnboardingResult.Invalid(
            "The code does not contain a Remagnet Proxy URL or token.",
        )
    }
    return OnboardingResult.Parsed(
        OnboardingPayload(proxyBaseUrl = proxy, proxyToken = token),
    )
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
