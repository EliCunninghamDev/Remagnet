package dev.remagnet.app.data

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Persist settings with the proxy token encrypted.
 *
 * JSON is written and read field by field rather than through reflective
 * serialization, so a missing field gets the documented default instead of a
 * JVM zero value and release builds do not need Gson keep rules for these
 * classes.
 *
 * Older builds wrote qBittorrent credentials and magnet defaults to the same
 * keys. Those fields are simply not read any more; a load leaves them in place
 * until the next save rewrites the objects with the proxy-only shape.
 */
class SettingsRepository(
    private val store: KeyValueStore,
    private val cipher: SecretCipher,
) {
    fun load(): RemagnetSettings {
        val public = readPublic()
        val secrets = readSecrets()
        return RemagnetSettings(
            proxyBaseUrl = public?.proxyBaseUrl ?: "",
            proxyToken = secrets.proxyToken,
        ).normalized()
    }

    /**
     * Validate and store a snapshot. Throws when the snapshot is not usable;
     * the settings screen validates first and renders the messages inline.
     */
    fun save(settings: RemagnetSettings): RemagnetSettings {
        val normalized = settings.normalized()
        val errors = normalized.validate()
        require(errors.isEmpty()) {
            errors.joinToString(separator = " ") { it.message }
        }

        write(normalized)
        return normalized
    }

    /**
     * Store a snapshot whose token was minted by the proxy itself.
     *
     * Pairing and direct sign-in receive an `rmg_…` token that the app never
     * typed, so the manual-entry minimum length does not apply. The URL and
     * token must still be present, and the URL still has to be a usable origin.
     */
    fun saveMinted(settings: RemagnetSettings): RemagnetSettings {
        val normalized = settings.normalized()
        require(parseHttpUrl(normalized.proxyBaseUrl) != null) {
            "The Remagnet Proxy URL must use http:// or https://."
        }
        require(normalized.proxyToken.isNotBlank()) {
            "The Remagnet Proxy token is required."
        }

        write(normalized)
        return normalized
    }

    /**
     * Keep the proxy URL but remove the device token.
     *
     * Disconnecting deliberately writes a snapshot that fails validation: the
     * form can still show which proxy was in use, while every request stays
     * blocked until the user signs in or pairs again.
     */
    fun saveDisconnected(proxyBaseUrl: String): RemagnetSettings {
        val normalized = RemagnetSettings(
            proxyBaseUrl = proxyBaseUrl,
            proxyToken = "",
        ).normalized()

        write(normalized)
        return normalized
    }

    private fun write(settings: RemagnetSettings) {
        store.putString(KEY_SECRETS, cipher.encrypt(encodeSecrets(settings)))
        store.putString(KEY_PUBLIC, encodePublic(settings))
    }

    private fun readPublic(): PublicSettings? {
        val raw = store.getString(KEY_PUBLIC) ?: return null
        return try {
            val json = JsonParser.parseString(raw).asJsonObject
            PublicSettings(
                proxyBaseUrl = json.stringOrDefault("proxyBaseUrl", ""),
            )
        } catch (_: Exception) {
            // A hand-edited or truncated value should not make the app
            // unopenable. Falling back to defaults is recoverable: the user
            // can simply save the settings screen again.
            store.putString(KEY_PUBLIC, null)
            null
        }
    }

    private fun readSecrets(): SecretSettings {
        val raw = store.getString(KEY_SECRETS) ?: return SecretSettings()
        val plaintext = cipher.decrypt(raw)
        if (plaintext == null) {
            store.putString(KEY_SECRETS, null)
            return SecretSettings()
        }

        return try {
            val json = JsonParser.parseString(plaintext).asJsonObject
            SecretSettings(
                proxyToken = json.stringOrDefault("proxyToken", ""),
            )
        } catch (_: Exception) {
            store.putString(KEY_SECRETS, null)
            SecretSettings()
        }
    }

    private fun encodePublic(settings: RemagnetSettings): String = JsonObject().apply {
        addProperty("proxyBaseUrl", settings.proxyBaseUrl)
    }.toString()

    private fun encodeSecrets(settings: RemagnetSettings): String = JsonObject().apply {
        addProperty("proxyToken", settings.proxyToken)
    }.toString()

    private fun JsonObject.stringOrNull(key: String): String? {
        val element = get(key) ?: return null
        if (!element.isJsonPrimitive || !element.asJsonPrimitive.isString) return null
        return element.asString
    }

    private fun JsonObject.stringOrDefault(key: String, default: String): String =
        stringOrNull(key) ?: default

    private data class PublicSettings(
        val proxyBaseUrl: String,
    )

    private data class SecretSettings(
        val proxyToken: String = "",
    )

    private companion object {
        const val KEY_PUBLIC = "settings.public.v1"
        const val KEY_SECRETS = "settings.secrets.v1"
    }
}

/**
 * The repository used by the app and the download service.
 *
 * Both paths need the same preferences file and Keystore key; sharing the
 * factory avoids the service reading a different store after a settings save.
 */
fun settingsRepositoryFor(context: Context): SettingsRepository {
    val preferences = context.getSharedPreferences("remagnet.settings", Context.MODE_PRIVATE)
    return SettingsRepository(
        store = SharedPreferencesStore(preferences),
        cipher = KeystoreSecretCipher(),
    )
}
