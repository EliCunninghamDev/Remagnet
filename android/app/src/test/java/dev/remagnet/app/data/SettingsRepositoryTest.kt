package dev.remagnet.app.data

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsRepositoryTest {
    private class FakeStore : KeyValueStore {
        val values = mutableMapOf<String, String>()

        override fun getString(key: String): String? = values[key]

        override fun putString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    /** A deliberately reversible stand-in; the real cipher is in the Keystore. */
    private class FakeCipher : SecretCipher {
        var failDecrypt = false

        override fun encrypt(plaintext: String): String =
            "enc:" + Base64.getEncoder().encodeToString(plaintext.toByteArray())

        override fun decrypt(ciphertext: String): String? {
            if (failDecrypt || !ciphertext.startsWith("enc:")) return null
            return String(Base64.getDecoder().decode(ciphertext.removePrefix("enc:")))
        }
    }

    private fun valid() = RemagnetSettings(
        proxyBaseUrl = "https://proxy.example.com",
        proxyToken = "0123456789abcdef",
    )

    @Test
    fun emptyStorageReturnsDefaults() {
        val settings = SettingsRepository(FakeStore(), FakeCipher()).load()

        assertEquals("", settings.proxyBaseUrl)
        assertEquals("", settings.proxyToken)
    }

    @Test
    fun roundTripsPublicAndSecretFields() {
        val store = FakeStore()
        val repository = SettingsRepository(store, FakeCipher())

        repository.save(valid())
        val loaded = repository.load()

        assertEquals("https://proxy.example.com", loaded.proxyBaseUrl)
        assertEquals("0123456789abcdef", loaded.proxyToken)
    }

    @Test
    fun neverWritesTheTokenInPlaintext() {
        val store = FakeStore()
        SettingsRepository(store, FakeCipher()).save(valid())

        val everything = store.values.values.joinToString("\n")
        assertFalse(everything.contains("0123456789abcdef"))
        assertTrue(everything.contains("enc:"))
    }

    @Test
    fun writesOnlyTheProxyFields() {
        val store = FakeStore()
        SettingsRepository(store, FakeCipher()).save(valid())

        val public = store.values.getValue("settings.public.v1")
        val secrets = store.values.getValue("settings.secrets.v1")
        assertFalse(public.contains("qbit"))
        assertFalse(public.contains("defaultCategory"))
        assertFalse(secrets.contains("qbit"))
    }

    @Test
    fun ignoresLegacyQbitFields() {
        val store = FakeStore()
        val cipher = FakeCipher()
        store.putString(
            "settings.public.v1",
            """
            {
              "qbitBaseUrl": "http://127.0.0.1:8080",
              "authMode": "password",
              "qbitUsername": "admin",
              "defaultCategory": "remagnet",
              "defaultTags": "remagnet, android",
              "proxyBaseUrl": "https://proxy.example.com"
            }
            """.trimIndent(),
        )
        store.putString(
            "settings.secrets.v1",
            cipher.encrypt("""{"qbitApiKey":"qbt_key","qbitPassword":"secret","proxyToken":"0123456789abcdef"}"""),
        )

        val loaded = SettingsRepository(store, cipher).load()

        assertEquals("https://proxy.example.com", loaded.proxyBaseUrl)
        assertEquals("0123456789abcdef", loaded.proxyToken)
    }

    @Test
    fun clearsUnreadableSecretsInsteadOfFailing() {
        val store = FakeStore()
        val cipher = FakeCipher()
        val repository = SettingsRepository(store, cipher)
        repository.save(valid())
        cipher.failDecrypt = true

        val loaded = repository.load()

        assertEquals("", loaded.proxyToken)
        assertNull(store.values["settings.secrets.v1"])
        // Public settings stay usable so the form can show what was configured.
        assertEquals("https://proxy.example.com", loaded.proxyBaseUrl)
    }

    @Test
    fun recoversFromCorruptPublicJson() {
        val store = FakeStore()
        store.putString("settings.public.v1", "{not json")
        val repository = SettingsRepository(store, FakeCipher())

        val loaded = repository.load()

        assertEquals("", loaded.proxyBaseUrl)
        assertNull(store.values["settings.public.v1"])
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesToSaveInvalidSettings() {
        SettingsRepository(FakeStore(), FakeCipher()).save(
            valid().copy(proxyBaseUrl = "not-a-url"),
        )
    }

    @Test
    fun defaultsFillMissingPublicFields() {
        val store = FakeStore()
        store.putString(
            "settings.public.v1",
            """{"qbitBaseUrl":"https://qbt.example.com"}""",
        )

        val loaded = SettingsRepository(store, FakeCipher()).load()

        assertEquals("", loaded.proxyBaseUrl)
    }
}
