package dev.remagnet.app.client

import com.google.gson.JsonParser
import dev.remagnet.app.data.normalizeBaseUrl
import dev.remagnet.app.data.parseHttpUrl
import dev.remagnet.proxy.apis.AuthApi
import dev.remagnet.proxy.infrastructure.ApiClient
import dev.remagnet.proxy.models.DeviceLoginRequest
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** The outcome of exchanging a proxy username and password for a device token. */
sealed interface DeviceLoginResult {
    /** Credentials were accepted and the proxy minted a token for this device. */
    data class SignedIn(
        val proxyBaseUrl: String,
        val token: String,
        val deviceName: String,
    ) : DeviceLoginResult

    /** The account has two-factor authentication enabled and needs a code. */
    data class TotpRequired(val message: String) : DeviceLoginResult

    data class Failed(val message: String) : DeviceLoginResult
}

/**
 * Sign in directly to the Remagnet Proxy.
 *
 * This is a second enrolment path beside pairing. `POST /api/auth/device`
 * mints a per-device `rmg_…` token, so the app never stores the administrator
 * password or a two-factor code. The generated [ApiClient] is built without an
 * auth interceptor: there is no token yet, and an old bearer header must not be
 * attached to the request that replaces it.
 */
class DeviceLoginClient(
    private val http: OkHttpClient = OkHttpClient(),
    private val defaultDeviceName: String = androidDeviceName(),
    private val createApi: (String) -> AuthApi = { baseUrl ->
        ApiClient(
            baseUrl = baseUrl,
            okHttpClientBuilder = http.newBuilder(),
        ).createService(AuthApi::class.java)
    },
) {
    suspend fun signIn(
        proxyBaseUrl: String,
        username: String,
        password: String,
        totpCode: String? = null,
        deviceName: String? = null,
    ): DeviceLoginResult = withContext(Dispatchers.IO) {
        val baseUrl = normalizeBaseUrl(proxyBaseUrl)
        if (parseHttpUrl(baseUrl) == null) {
            return@withContext DeviceLoginResult.Failed(INVALID_URL_MESSAGE)
        }

        val resolvedName = deviceName?.takeIf { it.isNotBlank() } ?: defaultDeviceName
        val request = DeviceLoginRequest(
            username = username.trim(),
            password = password,
            totpCode = totpCode?.takeIf { it.isNotBlank() },
            deviceName = resolvedName,
        )

        val response = try {
            createApi(baseUrl).loginDevice(request)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IOException) {
            return@withContext DeviceLoginResult.Failed(
                "Could not reach the Remagnet Proxy at $baseUrl. Check the URL and network.",
            )
        } catch (error: Exception) {
            return@withContext DeviceLoginResult.Failed(
                error.message ?: "Could not reach the Remagnet Proxy at $baseUrl.",
            )
        }

        if (!response.isSuccessful) {
            val failure = parseFailure(response.errorBody()?.string())
            return@withContext when {
                response.code() == 401 && failure?.code == TOTP_REQUIRED -> {
                    DeviceLoginResult.TotpRequired(
                        failure.error ?: "Enter the two-factor code for this account.",
                    )
                }

                response.code() == 401 -> DeviceLoginResult.Failed(
                    if (totpCode.isNullOrBlank()) {
                        "The username or password is incorrect."
                    } else {
                        "The username, password, or two-factor code is incorrect."
                    },
                )

                response.code() == 429 -> DeviceLoginResult.Failed(
                    failure?.error
                        ?: "Too many sign-in attempts. Wait a few minutes and try again.",
                )

                else -> DeviceLoginResult.Failed(
                    failure?.error
                        ?: "The Remagnet Proxy rejected the sign-in (HTTP ${response.code()}).",
                )
            }
        }

        val token = response.body()?.token?.trim().orEmpty()
        if (token.isBlank()) {
            return@withContext DeviceLoginResult.Failed(
                "The Remagnet Proxy did not return a device token. Try again.",
            )
        }

        DeviceLoginResult.SignedIn(
            proxyBaseUrl = baseUrl,
            token = token,
            deviceName = resolvedName,
        )
    }

    private fun parseFailure(text: String?): Failure? {
        if (text.isNullOrBlank()) return null
        return try {
            val json = JsonParser.parseString(text).asJsonObject
            Failure(
                error = json.get("error")
                    ?.takeIf { it.isJsonPrimitive }
                    ?.asString,
                code = json.get("code")
                    ?.takeIf { it.isJsonPrimitive }
                    ?.asString,
            )
        } catch (_: Exception) {
            null
        }
    }

    private data class Failure(val error: String?, val code: String?)

    private companion object {
        const val TOTP_REQUIRED = "totp_required"

        const val INVALID_URL_MESSAGE =
            "Enter a valid http:// or https:// Remagnet Proxy URL, without a query or fragment."
    }
}
