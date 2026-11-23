package dev.remagnet.app.client

import com.sun.net.httpserver.HttpServer
import dev.remagnet.app.data.RemagnetSettings
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ProxyHealthClientTest {
    private lateinit var server: HttpServer
    private var authorization: String? = null
    private var healthCode = 200
    private var healthBody =
        """{"ok":true,"clientLabel":"qBittorrent","appVersion":"5.3.0",""" +
            """"webApiVersion":"2.16.2","capabilities":{"pauseOnAdd":true},""" +
            """"defaultCategory":"remagnet","defaultTags":["remagnet"]}"""

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/healthz") { exchange ->
            respond(exchange, 200, """{"ok":true,"service":"remagnet-bridge","version":"0.1.0"}""")
        }
        server.createContext("/api/health") { exchange ->
            authorization = exchange.requestHeaders.getFirst("Authorization")
            respond(exchange, healthCode, healthBody)
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun settings(token: String = "0123456789abcdef") = RemagnetSettings(
        proxyBaseUrl = "http://127.0.0.1:${server.address.port}",
        proxyToken = token,
    )

    @Test
    fun reportsQbitVersionsAndSendsBearerToken() = runBlocking {
        val status = ProxyHealthClient().check(settings())

        assertTrue(status.toString(), status is ProxyStatus.Online)
        status as ProxyStatus.Online
        assertEquals("5.3.0", status.appVersion)
        assertEquals("2.16.2", status.webApiVersion)
        assertEquals("Bearer 0123456789abcdef", authorization)
    }

    @Test
    fun mapsUnauthorizedToken() = runBlocking {
        healthCode = 401
        healthBody = """{"error":"Missing or invalid bridge token."}"""

        val status = ProxyHealthClient().check(settings())

        assertTrue(status.toString(), status is ProxyStatus.Unauthorized)
        assertEquals(
            "Missing or invalid bridge token.",
            (status as ProxyStatus.Unauthorized).message,
        )
    }

    @Test
    fun mapsQbitFailuresSeparatelyFromProxyFailures() = runBlocking {
        healthCode = 502
        healthBody = """{"error":"qBittorrent is unreachable."}"""

        val status = ProxyHealthClient().check(settings())

        assertTrue(status.toString(), status is ProxyStatus.QbitUnavailable)
        assertEquals(
            "qBittorrent is unreachable.",
            (status as ProxyStatus.QbitUnavailable).message,
        )
    }

    @Test
    fun reportsAnUnreachableProxy() = runBlocking {
        val closedPort = ServerSocket(0).use { it.localPort }

        val status = ProxyHealthClient().check(
            RemagnetSettings(
                proxyBaseUrl = "http://127.0.0.1:$closedPort",
                proxyToken = "0123456789abcdef",
            ),
        )

        assertTrue(status.toString(), status is ProxyStatus.Unreachable)
    }

    @Test
    fun skipsNetworkCallsWhenProxyIsDisabled() = runBlocking {
        val status = ProxyHealthClient().check(RemagnetSettings())

        assertEquals(ProxyStatus.NotConfigured, status)
    }

    @Test
    fun reportsInvalidSettingsWithoutCallingTheNetwork() = runBlocking {
        val status = ProxyHealthClient().check(
            RemagnetSettings(
                proxyBaseUrl = "not-a-url",
                proxyToken = "0123456789abcdef",
            ),
        )

        assertTrue(status is ProxyStatus.Misconfigured)
    }

    private fun respond(
        exchange: com.sun.net.httpserver.HttpExchange,
        code: Int,
        body: String,
    ) {
        val bytes = body.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
