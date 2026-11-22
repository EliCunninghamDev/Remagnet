package dev.remagnet.app.data

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Persist settings with the three credentials encrypted.
 *
 * JSON is written and read field by field rather than through reflective
 * serialization, so a missing field gets the documented default instead of a
 * JVM zero value and release builds do not need Gson keep rules for these
 * classes.
 */
class SettingsRepository(
    private val store: KeyValueStore,
    private val cipher: SecretCipher,
) {
    fun load(): RemagnetSettings {
        val public = readPublic()
        val secrets = readSecrets()
        return RemagnetSettings(
            qbitBaseUrl = public?.qbitBaseUrl ?: DEFAULT_QBIT_BASE_URL,
            authMode = public?.authMode ?: AuthMode.ApiKey,
            qbitApiKey = secrets.qbitApiKey,
            qbitUsername = public?.qbitUsername ?: "admin",
            qbitPassword = secrets.qbitPassword,
            defaultCategory = public?.defaultCategory ?: DEFAULT_CATEGORY,
            defaultTags = public?.defaultTags ?: DEFAULT_TAGS,
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
        val errors = validateSettings(normalized)
        require(errors.isEmpty()) {
            errors.joinToString(separator = " ") { it.message }
        }

        store.putString(KEY_SECRETS, cipher.encrypt(encodeSecrets(normalized)))
        store.putString(KEY_PUBLIC, encodePublic(normalized))
        return normalized
    }

    private fun readPublic(): PublicSettings? {
        val raw = store.getString(KEY_PUBLIC) ?: return null
        return try {
            val json = JsonParser.parseString(raw).asJsonObject
            PublicSettings(
                qbitBaseUrl = json.stringOrDefault("qbitBaseUrl", DEFAULT_QBIT_BASE_URL),
                authMode = AuthMode.fromStorage(json.stringOrNull("authMode")),
                qbitUsername = json.stringOrDefault("qbitUsername", "admin"),
                defaultCategory = json.stringOrDefault("defaultCategory", DEFAULT_CATEGORY),
                defaultTags = json.stringOrDefault("defaultTags", DEFAULT_TAGS),
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
                qbitApiKey = json.stringOrDefault("qbitApiKey", ""),
                qbitPassword = json.stringOrDefault("qbitPassword", ""),
                proxyToken = json.stringOrDefault("proxyToken", ""),
            )
        } catch (_: Exception) {
            store.putString(KEY_SECRETS, null)
            SecretSettings()
        }
    }

    private fun encodePublic(settings: RemagnetSettings): String = JsonObject().apply {
        addProperty("qbitBaseUrl", settings.qbitBaseUrl)
        addProperty("authMode", settings.authMode.storageValue)
        addProperty("qbitUsername", settings.qbitUsername)
        addProperty("defaultCategory", settings.defaultCategory)
        addProperty("defaultTags", settings.defaultTags)
        addProperty("proxyBaseUrl", settings.proxyBaseUrl)
    }.toString()

    private fun encodeSecrets(settings: RemagnetSettings): String = JsonObject().apply {
        addProperty("qbitApiKey", settings.qbitApiKey)
        addProperty("qbitPassword", settings.qbitPassword)
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
        val qbitBaseUrl: String,
        val authMode: AuthMode,
        val qbitUsername: String,
        val defaultCategory: String,
        val defaultTags: String,
        val proxyBaseUrl: String,
    )

    private data class SecretSettings(
        val qbitApiKey: String = "",
        val qbitPassword: String = "",
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
