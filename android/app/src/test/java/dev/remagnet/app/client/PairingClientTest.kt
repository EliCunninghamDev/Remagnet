package dev.remagnet.app.client

import com.sun.net.httpserver.HttpServer
import dev.remagnet.app.data.PairingCrypto
import dev.remagnet.app.data.PairingLink
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairingClientTest {
    private lateinit var server: HttpServer
    private val code = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 32 zero bytes
    private val payload = """
        {
          "version": 2,
          "proxyToken": "0123456789abcdef"
        }
    """.trimIndent()

    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    private var receivedBody = ""

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun link() = PairingLink(
        proxyBaseUrl = "http://127.0.0.1:${server.address.port}",
        id = "session-1",
        code = code,
    )

    private fun respond(body: String, status: Int = 200) {
        server.createContext("/api/pair/claim") { exchange ->
            receivedBody = exchange.requestBody.readBytes().decodeToString()
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @Test
    fun claimsAndDecryptsTheProxySettings() = runBlocking {
        val nonce = ByteArray(12) { it.toByte() }
        val (iv, data) = PairingCrypto.encrypt("session-1", code, nonce, payload)
        respond("""{"iv":"$iv","data":"$data"}""")

        val result = PairingClient(http).claim(link()) as PairingClaim.Success
        val settings = result.settings

        assertEquals("http://127.0.0.1:${server.address.port}", settings.proxyBaseUrl)
        assertEquals("0123456789abcdef", settings.proxyToken)
        assertTrue(receivedBody.contains("\"id\":\"session-1\""))
        assertTrue(receivedBody.contains("\"proof\":\"${PairingCrypto.proof(code)}\""))
        assertTrue(!receivedBody.contains(code))
    }

    @Test
    fun reportsAnExpiredCode() = runBlocking {
        respond("""{"error":"The pairing code is invalid or expired."}""", status = 400)

        val result = PairingClient(http).claim(link())

        assertTrue(result is PairingClaim.Failed)
        assertEquals(
            "The pairing code is invalid or expired.",
            (result as PairingClaim.Failed).message,
        )
    }

    @Test
    fun rejectsAResponseEncryptedForAnotherCode() = runBlocking {
        val otherCode = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        val (iv, data) = PairingCrypto.encrypt("session-1", otherCode, ByteArray(12), payload)
        respond("""{"iv":"$iv","data":"$data"}""")

        val result = PairingClient(http).claim(link())

        assertTrue(result is PairingClaim.Failed)
        assertTrue((result as PairingClaim.Failed).message.contains("could not be decrypted"))
    }

    @Test
    fun rejectsAnOlderPayloadVersion() = runBlocking {
        val (iv, data) = PairingCrypto.encrypt(
            "session-1",
            code,
            ByteArray(12),
            """{"version":1,"qbitBaseUrl":"https://qbt.example.com"}""",
        )
        respond("""{"iv":"$iv","data":"$data"}""")

        val result = PairingClient(http).claim(link())

        assertTrue(result is PairingClaim.Failed)
        assertTrue(
            (result as PairingClaim.Failed).message.contains("unsupported version"),
        )
    }
}
