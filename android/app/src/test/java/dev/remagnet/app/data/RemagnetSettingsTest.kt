package dev.remagnet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemagnetSettingsTest {
    private fun valid() = RemagnetSettings(
        qbitBaseUrl = "http://127.0.0.1:8080",
        authMode = AuthMode.ApiKey,
        qbitApiKey = "qbt_example",
        proxyBaseUrl = "https://remagnet.example.com",
        proxyToken = "0123456789abcdef",
    )

    @Test
    fun normalizesUrlsAndTags() {
        val normalized = RemagnetSettings(
            qbitBaseUrl = "  http://127.0.0.1:8080///  ",
            qbitApiKey = "  qbt_key  ",
            qbitUsername = "  admin  ",
            defaultCategory = "  remagnet  ",
            defaultTags = " remagnet, android, , remagnet ",
            proxyBaseUrl = " https://proxy.example.com/// ",
            proxyToken = " 0123456789abcdef ",
        ).normalized()

        assertEquals("http://127.0.0.1:8080", normalized.qbitBaseUrl)
        assertEquals("qbt_key", normalized.qbitApiKey)
        assertEquals("admin", normalized.qbitUsername)
        assertEquals("remagnet", normalized.defaultCategory)
        assertEquals("remagnet, android", normalized.defaultTags)
        assertEquals("https://proxy.example.com", normalized.proxyBaseUrl)
        assertEquals("0123456789abcdef", normalized.proxyToken)
    }

    @Test
    fun keepsPasswordWhitespace() {
        val normalized = RemagnetSettings(qbitPassword = "  secret  ").normalized()

        assertEquals("  secret  ", normalized.qbitPassword)
    }

    @Test
    fun acceptsAValidApiKeyConfiguration() {
        assertTrue(validateSettings(valid()).isEmpty())
    }

    @Test
    fun requiresApiKeyOrACompletePassword() {
        val missingKey = validateSettings(valid().copy(qbitApiKey = ""))
        assertEquals(SettingsField.QbitApiKey, missingKey.single().field)

        val passwordMode = valid().copy(
            authMode = AuthMode.Password,
            qbitUsername = "",
            qbitPassword = "",
        )
        val fields = validateSettings(passwordMode).map { it.field }
        assertTrue(SettingsField.QbitUsername in fields)
        assertTrue(SettingsField.QbitPassword in fields)
    }

    @Test
    fun rejectsUrlsWithCredentialsQueryOrFragment() {
        listOf(
            "ftp://127.0.0.1:8080",
            "http://user:pass@127.0.0.1:8080",
            "http://127.0.0.1:8080/api?x=1",
            "http://127.0.0.1:8080/#fragment",
            "not a url",
        ).forEach { url ->
            val errors = validateSettings(valid().copy(qbitBaseUrl = url))
            assertEquals("expected $url to be rejected", SettingsField.QbitUrl, errors.first().field)
        }
    }

    @Test
    fun treatsAnEmptyProxyAsDisabled() {
        val errors = validateSettings(
            valid().copy(proxyBaseUrl = "", proxyToken = ""),
        )

        assertTrue(errors.isEmpty())
    }

    @Test
    fun rejectsHalfConfiguredProxy() {
        val urlOnly = validateSettings(valid().copy(proxyToken = ""))
        assertEquals(SettingsField.ProxyToken, urlOnly.single().field)

        val tokenOnly = validateSettings(valid().copy(proxyBaseUrl = ""))
        assertEquals(SettingsField.ProxyUrl, tokenOnly.single().field)
    }

    @Test
    fun rejectsShortProxyToken() {
        val errors = validateSettings(valid().copy(proxyToken = "short"))

        assertEquals(SettingsField.ProxyToken, errors.single().field)
    }

    @Test
    fun requiresProxyUrlWhenTokenIsPresent() {
        val errors = validateSettings(
            valid().copy(proxyBaseUrl = "http://proxy.example.com?token=hidden"),
        )

        assertEquals(SettingsField.ProxyUrl, errors.single().field)
    }
}
