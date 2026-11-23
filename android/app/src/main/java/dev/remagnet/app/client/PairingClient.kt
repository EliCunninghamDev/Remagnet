package dev.remagnet.app.client

import com.google.gson.Gson
import com.google.gson.JsonParser
import dev.remagnet.app.data.PairedSettings
import dev.remagnet.app.data.PairingCrypto
import dev.remagnet.app.data.PairingLink
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

sealed interface PairingClaim {
    data class Success(val settings: PairedSettings) : PairingClaim

    data class Failed(val message: String) : PairingClaim
}

/**
 * Claim a `remagnet://pair` code.
 *
 * Only the code's hash is sent to the proxy. The response is encrypted with a
 * key derived from the code, so a proxy access log or a TLS-terminating
 * reverse proxy never sees the proxy token.
 */
class PairingClient(
    private val http: OkHttpClient = OkHttpClient(),
    private val gson: Gson = Gson(),
) {
    suspend fun claim(link: PairingLink): PairingClaim = withContext(Dispatchers.IO) {
        val proof = try {
            PairingCrypto.proof(link.code)
        } catch (_: Exception) {
            return@withContext PairingClaim.Failed(
                "The pairing code is malformed. Show a new code and scan it again.",
            )
        }

        val body = gson.toJson(mapOf("id" to link.id, "proof" to proof))
            .toRequestBody(JSON)
        val request = Request.Builder()
            .url("${link.proxyBaseUrl.trimEnd('/')}/api/pair/claim")
            .header("Accept", "application/json")
            .post(body)
            .build()

        val response = try {
            http.newCall(request).execute()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IOException) {
            return@withContext PairingClaim.Failed(
                "Could not reach the Remagnet Proxy at ${link.proxyBaseUrl}. Check the URL and network.",
            )
        } catch (error: Exception) {
            return@withContext PairingClaim.Failed(
                error.message ?: "Could not reach the Remagnet Proxy.",
            )
        }

        response.use {
            val text = runCatching { it.body.string() }.getOrDefault("")
            if (!it.isSuccessful) {
                val detail = runCatching {
                    JsonParser.parseString(text).asJsonObject["error"]?.asString
                }.getOrNull()
                return@withContext PairingClaim.Failed(
                    detail ?: "The pairing code was rejected (HTTP ${it.code}).",
                )
            }

            val encrypted = try {
                gson.fromJson(text, EncryptedResponse::class.java)
            } catch (_: Exception) {
                null
            }
            if (encrypted == null || encrypted.iv.isBlank() || encrypted.data.isBlank()) {
                return@withContext PairingClaim.Failed(
                    "The Remagnet Proxy sent an incomplete pairing response.",
                )
            }

            val plaintext = try {
                PairingCrypto.decrypt(link.id, link.code, encrypted.iv, encrypted.data)
            } catch (_: Exception) {
                return@withContext PairingClaim.Failed(
                    "The pairing response could not be decrypted. Show a new code and scan it again.",
                )
            }

            val settings = try {
                PairingCrypto.parsePayload(plaintext, link.proxyBaseUrl)
            } catch (error: IllegalArgumentException) {
                return@withContext PairingClaim.Failed(
                    error.message ?: "The Remagnet Proxy returned unusable connection settings.",
                )
            }

            PairingClaim.Success(settings)
        }
    }
}

private val JSON = "application/json; charset=utf-8".toMediaType()

private data class EncryptedResponse(
    val iv: String = "",
    val data: String = "",
)
