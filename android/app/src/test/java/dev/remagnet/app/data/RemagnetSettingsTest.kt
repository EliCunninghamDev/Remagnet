package dev.remagnet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemagnetSettingsTest {
    private fun valid() = RemagnetSettings(
        proxyBaseUrl = "https://remagnet.example.com",
        proxyToken = "0123456789abcdef",
    )

    @Test
    fun normalizesUrlAndToken() {
        val normalized = RemagnetSettings(
            proxyBaseUrl = " https://proxy.example.com/// ",
            proxyToken = " 0123456789abcdef ",
        ).normalized()

        assertEquals("https://proxy.example.com", normalized.proxyBaseUrl)
        assertEquals("0123456789abcdef", normalized.proxyToken)
    }

    @Test
    fun acceptsAValidProxyConfiguration() {
        assertTrue(validateSettings(valid()).isEmpty())
        assertTrue(valid().validate().isEmpty())
        assertTrue(valid().archiveReady)
    }

    @Test
    fun requiresBothFields() {
        val missingUrl = validateSettings(valid().copy(proxyBaseUrl = ""))
        assertEquals(SettingsField.ProxyUrl, missingUrl.single().field)

        val missingToken = validateSettings(valid().copy(proxyToken = ""))
        assertEquals(SettingsField.ProxyToken, missingToken.single().field)
    }

    @Test
    fun rejectsUrlsWithCredentialsQueryOrFragment() {
        listOf(
            "ftp://proxy.example.com",
            "http://user:pass@proxy.example.com",
            "https://proxy.example.com/api?x=1",
            "https://proxy.example.com/#fragment",
            "not a url",
        ).forEach { url ->
            val errors = validateSettings(valid().copy(proxyBaseUrl = url))
            assertEquals("expected $url to be rejected", SettingsField.ProxyUrl, errors.first().field)
        }
    }

    @Test
    fun rejectsShortProxyToken() {
        val errors = validateSettings(valid().copy(proxyToken = "short"))

        assertEquals(SettingsField.ProxyToken, errors.single().field)
    }

    @Test
    fun anIncompleteSnapshotIsNotReady() {
        assertFalse(RemagnetSettings().archiveReady)
        assertFalse(
            RemagnetSettings(
                proxyBaseUrl = "https://remagnet.example.com",
                proxyToken = "",
            ).archiveReady,
        )
    }
}
