package dev.remagnet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PairingCryptoTest {
    private val code = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 32 zero bytes

    @Test
    fun proofMatchesTheProxyVector() {
        assertEquals(
            "Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU",
            PairingCrypto.proof(code),
        )
    }

    @Test
    fun derivedKeyMatchesTheProxyVector() {
        val key = PairingCrypto.key("session-1", ByteArray(32))

        assertEquals(
            "16b60074418123a116eedf6e311f3d53e4e8430ec78c34e6b8dc18b6f3c24a46",
            key.joinToString("") { "%02x".format(it) },
        )
    }

    @Test
    fun decryptsAnEncryptedPayload() {
        val nonce = ByteArray(12) { it.toByte() }
        val plaintext = """{"version":2,"proxyToken":"0123456789abcdef"}"""
        val (iv, data) = PairingCrypto.encrypt("session-1", code, nonce, plaintext)

        assertEquals(plaintext, PairingCrypto.decrypt("session-1", code, iv, data))
    }

    @Test
    fun aDifferentSessionIdCannotDecrypt() {
        val nonce = ByteArray(12) { it.toByte() }
        val (iv, data) = PairingCrypto.encrypt("session-1", code, nonce, "secret")

        assertNotEquals(
            "secret",
            runCatching { PairingCrypto.decrypt("session-2", code, iv, data) }.getOrNull(),
        )
    }
}
