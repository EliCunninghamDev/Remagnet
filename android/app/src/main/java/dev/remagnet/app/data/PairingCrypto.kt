package dev.remagnet.app.data

import com.google.gson.JsonParser
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Connection settings returned by a successful v2 pairing claim. */
data class PairedSettings(
    val proxyBaseUrl: String,
    val proxyToken: String,
)

/**
 * The client half of the mobile pairing exchange.
 *
 * The QR code carries a base64url secret. The phone sends only
 * `SHA-256(secret)` to the proxy, then derives the AES key from the secret and
 * the session id. A logged request or response therefore cannot be replayed or
 * decrypted without the QR image.
 */
object PairingCrypto {
    private const val CONTEXT = "remagnet-pair-v1"
    private const val PAYLOAD_VERSION = 2
    private val UTF_8 = Charsets.UTF_8

    /** `SHA-256(code)` in the base64url form the claim endpoint expects. */
    fun proof(code: String): String = encode(sha256(decode(code)))

    /** Decrypt the proxy's AES-256-GCM response. */
    fun decrypt(id: String, code: String, iv: String, data: String): String {
        val secret = decode(code)
        require(secret.size == 32) { "The pairing code is not a 32-byte secret." }
        val nonce = decode(iv)
        require(nonce.size == 12) { "The pairing response has an invalid nonce." }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key(id, secret), "AES"),
            GCMParameterSpec(128, nonce),
        )
        return String(cipher.doFinal(decode(data)), UTF_8)
    }

    /**
     * Parse and validate the decrypted pairing payload.
     *
     * Version 2 contains only the proxy token; qBittorrent credentials stay on
     * the proxy. Throws [IllegalArgumentException] with a message safe to show
     * when the payload is unusable or was produced by an older proxy.
     */
    fun parsePayload(plaintext: String, proxyBaseUrl: String): PairedSettings {
        val json = try {
            JsonParser.parseString(plaintext).asJsonObject
        } catch (_: Exception) {
            throw IllegalArgumentException(
                "The Remagnet Proxy returned unreadable connection settings.",
            )
        }

        val version = json.get("version")
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }
            ?.asInt
        if (version != PAYLOAD_VERSION) {
            throw IllegalArgumentException(
                "This pairing response uses an unsupported version. " +
                    "Update the Remagnet Proxy or the app and try again.",
            )
        }

        val token = json.get("proxyToken")
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }
            ?.asString
            ?.trim()
            .orEmpty()
        if (token.isEmpty()) {
            throw IllegalArgumentException(
                "The Remagnet Proxy returned incomplete connection settings.",
            )
        }

        return PairedSettings(
            proxyBaseUrl = normalizeBaseUrl(proxyBaseUrl),
            proxyToken = token,
        )
    }

    /**
     * Encrypt a test payload with the same key derivation as the proxy.
     *
     * Kept internal so unit tests can stand up a fake claim endpoint without a
     * second crypto implementation.
     */
    internal fun encrypt(
        id: String,
        code: String,
        nonce: ByteArray,
        plaintext: String,
    ): Pair<String, String> {
        require(nonce.size == 12) { "Use a 12-byte nonce." }
        val secret = decode(code)
        require(secret.size == 32) { "The pairing code is not a 32-byte secret." }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key(id, secret), "AES"),
            GCMParameterSpec(128, nonce),
        )
        val ciphertext = cipher.doFinal(plaintext.toByteArray(UTF_8))
        return encode(nonce) to encode(ciphertext)
    }

    internal fun key(id: String, secret: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(CONTEXT.toByteArray(UTF_8))
        digest.update(id.toByteArray(UTF_8))
        digest.update(secret)
        return digest.digest()
    }

    private fun sha256(bytes: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun decode(value: String): ByteArray {
        val padded = value + "=".repeat((4 - value.length % 4) % 4)
        return Base64.getUrlDecoder().decode(padded)
    }

    private fun encode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
