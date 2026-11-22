package dev.remagnet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingTest {
    @Test
    fun parsesAConnectUri() {
        val result = parseOnboarding(
            "remagnet://connect?qbit=https%3A%2F%2Fqbt.example.com" +
                "&apiKey=qbt_key&proxy=https%3A%2F%2Fproxy.example.com" +
                "&token=abc%2Bdef%2F0123456789&category=remagnet&tags=games%2C%20isos",
        ) as OnboardingResult.Parsed

        assertEquals("https://qbt.example.com", result.payload.qbitBaseUrl)
        assertEquals("qbt_key", result.payload.qbitApiKey)
        assertEquals("https://proxy.example.com", result.payload.proxyBaseUrl)
        // `+` is a literal plus in these values; spaces arrive as %20.
        assertEquals("abc+def/0123456789", result.payload.proxyToken)
        assertEquals("remagnet", result.payload.defaultCategory)
        assertEquals("games, isos", result.payload.defaultTags)
        assertEquals(AuthMode.ApiKey, result.payload.authMode)
    }

    @Test
    fun parsesJson() {
        val result = parseOnboarding(
            """
            {
              "qbitUrl": "https://qbt.example.com",
              "username": "admin",
              "password": " secret ",
              "proxyUrl": "https://proxy.example.com",
              "token": "0123456789abcdef",
              "authMode": "password"
            }
            """.trimIndent(),
        ) as OnboardingResult.Parsed

        assertEquals("https://qbt.example.com", result.payload.qbitBaseUrl)
        assertEquals("admin", result.payload.qbitUsername)
        assertEquals(" secret ", result.payload.qbitPassword)
        assertEquals("https://proxy.example.com", result.payload.proxyBaseUrl)
        assertEquals("0123456789abcdef", result.payload.proxyToken)
        assertEquals(AuthMode.Password, result.payload.authMode)
    }

    @Test
    fun acceptsABareHttpUrlAsAProxyUrl() {
        val result = parseOnboarding("https://remagnet.example.com") as OnboardingResult.Parsed

        assertEquals("https://remagnet.example.com", result.payload.proxyBaseUrl)
        assertNull(result.payload.qbitBaseUrl)
    }

    @Test
    fun rejectsWrongSchemeOrHost() {
        val wrongScheme = parseOnboarding("ftp://example.com/connect?token=abc")
        val wrongHost = parseOnboarding("remagnet://settings?token=abc")

        assertTrue(wrongScheme is OnboardingResult.Invalid)
        assertTrue(wrongHost is OnboardingResult.Invalid)
    }

    @Test
    fun rejectsACodeWithoutConnectionFields() {
        val result = parseOnboarding("remagnet://connect?version=1")

        assertTrue(result is OnboardingResult.Invalid)
    }

    @Test
    fun rejectsEmptyInput() {
        assertTrue(parseOnboarding("   ") is OnboardingResult.Invalid)
    }

    @Test
    fun parsesAPairingUri() {
        val result = parseOnboarding(
            "remagnet://pair?url=https%3A%2F%2Fproxy.example.com&id=session-1&code=abc%2Bdef",
        ) as OnboardingResult.Pairing

        assertEquals("https://proxy.example.com", result.link.proxyBaseUrl)
        assertEquals("session-1", result.link.id)
        assertEquals("abc+def", result.link.code)
    }

    @Test
    fun acceptsPlainHttpPairingOnlyForLoopback() {
        val loopback = parseOnboarding(
            "remagnet://pair?url=http%3A%2F%2F127.0.0.1%3A8080&id=a&code=b",
        )
        val ipv6Loopback = parseOnboarding(
            "remagnet://pair?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8080&id=a&code=b",
        )
        val remote = parseOnboarding(
            "remagnet://pair?url=http%3A%2F%2Fproxy.example.com&id=a&code=b",
        )

        assertTrue(loopback is OnboardingResult.Pairing)
        assertTrue(ipv6Loopback is OnboardingResult.Pairing)
        assertTrue(remote is OnboardingResult.Invalid)
    }

    @Test
    fun rejectsIncompletePairingCodes() {
        val missingCode = parseOnboarding(
            "remagnet://pair?url=https%3A%2F%2Fproxy.example.com&id=session-1",
        )
        val missingUrl = parseOnboarding("remagnet://pair?id=session-1&code=abc")

        assertTrue(missingCode is OnboardingResult.Invalid)
        assertTrue(missingUrl is OnboardingResult.Invalid)
    }

    @Test
    fun mergesOnlyPresentFields() {
        val current = RemagnetSettings(
            qbitBaseUrl = "http://old.example.com",
            qbitApiKey = "old-key",
            defaultCategory = "old-category",
            proxyBaseUrl = "https://old-proxy.example.com",
            proxyToken = "old-token-0123456789",
        )
        val payload = OnboardingPayload(
            qbitBaseUrl = "https://new.example.com",
            proxyToken = "new-token-0123456789",
        )

        val merged = payload.applyTo(current)

        assertEquals("https://new.example.com", merged.qbitBaseUrl)
        assertEquals("https://old-proxy.example.com", merged.proxyBaseUrl)
        assertEquals("new-token-0123456789", merged.proxyToken)
        assertEquals("old-key", merged.qbitApiKey)
        assertEquals("old-category", merged.defaultCategory)
        assertEquals(AuthMode.ApiKey, merged.authMode)
    }

    @Test
    fun infersPasswordModeFromCredentials() {
        val current = RemagnetSettings()
        val payload = OnboardingPayload(
            qbitUsername = "admin",
            qbitPassword = "secret",
        )

        assertEquals(AuthMode.Password, payload.applyTo(current).authMode)
    }
}
