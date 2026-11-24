package dev.remagnet.app.client

import com.google.gson.JsonParser
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.validateProxySettings
import dev.remagnet.app.proxy.ProxyApi
import java.io.IOException
import kotlinx.coroutines.CancellationException
import retrofit2.Response

/** What the proxy can tell us about itself and its qBittorrent link. */
sealed interface ProxyStatus {
    data object NotConfigured : ProxyStatus

    data class Online(
        val appVersion: String,
        val webApiVersion: String,
        val clientLabel: String = "",
    ) : ProxyStatus

    data class Unauthorized(val message: String) : ProxyStatus

    /** The proxy answered, but its saved qBittorrent connection did not. */
    data class QbitUnavailable(val message: String) : ProxyStatus

    data class Unreachable(val message: String) : ProxyStatus

    data class Misconfigured(val message: String) : ProxyStatus
}

/**
 * Check the proxy in two steps: liveness proves the URL is reachable, then
 * `/api/health` proves the token and the proxy's qBittorrent connection.
 * Splitting the calls gives the user an actionable message instead of one
 * generic failure.
 */
class ProxyHealthClient(
    private val createApi: (baseUrl: String, token: String) -> ProxyApi = { url, token ->
        ProxyApi(url, token)
    },
) {
    suspend fun check(settings: RemagnetSettings): ProxyStatus {
        if (!settings.proxyConfigured) return ProxyStatus.NotConfigured
        if (validateProxySettings(settings).isNotEmpty()) {
            return ProxyStatus.Misconfigured(
                "The Remagnet Proxy settings are incomplete. Check the URL and token in Settings.",
            )
        }

        val api = try {
            createApi(settings.proxyBaseUrl, settings.proxyToken)
        } catch (error: IllegalArgumentException) {
            return ProxyStatus.Misconfigured(error.message ?: "The Remagnet Proxy URL is not valid.")
        }

        val liveness = try {
            api.service.getLiveness()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: IOException) {
            return ProxyStatus.Unreachable(
                describeProxyConnectionFailure(error, settings.proxyBaseUrl),
            )
        } catch (error: Exception) {
            return ProxyStatus.Unreachable(
                error.message ?: "Could not reach the Remagnet Proxy at ${settings.proxyBaseUrl}.",
            )
        }

        if (!liveness.isSuccessful) {
            return ProxyStatus.Unreachable(
                "The Remagnet Proxy answered with HTTP ${liveness.code()} instead of its liveness status.",
            )
        }

        val health = try {
            api.configuration.checkQbitConnection()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: IOException) {
            return ProxyStatus.Unreachable(
                describeProxyConnectionFailure(error, settings.proxyBaseUrl),
            )
        } catch (error: Exception) {
            return ProxyStatus.Unreachable(
                error.message ?: "The Remagnet Proxy stopped responding while checking qBittorrent.",
            )
        }

        val body = health.body()
        if (health.isSuccessful && body != null) {
            return ProxyStatus.Online(
                appVersion = body.appVersion,
                webApiVersion = body.webApiVersion,
                clientLabel = body.clientLabel,
            )
        }

        if (health.code() == 401) {
            return ProxyStatus.Unauthorized(
                errorMessage(health) ?: "The Remagnet Proxy token is missing or invalid.",
            )
        }

        if (health.code() == 503) {
            return ProxyStatus.QbitUnavailable(
                errorMessage(health)
                    ?: "The Remagnet Proxy has no qBittorrent credentials configured yet.",
            )
        }

        return ProxyStatus.QbitUnavailable(
            errorMessage(health)
                ?: "The Remagnet Proxy could not reach qBittorrent (HTTP ${health.code()}).",
        )
    }

    private fun errorMessage(response: Response<*>): String? {
        val text = try {
            response.errorBody()?.string()
        } catch (_: IOException) {
            null
        } ?: return null

        return try {
            val entry = JsonParser.parseString(text).asJsonObject.get("error")
            if (entry != null && entry.isJsonPrimitive) entry.asString else null
        } catch (_: Exception) {
            null
        }
    }
}
