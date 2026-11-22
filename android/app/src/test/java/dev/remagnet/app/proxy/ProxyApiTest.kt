package dev.remagnet.app.proxy

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ProxyApiTest {
    private lateinit var server: HttpServer
    private var authorization: String? = null

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/health") { exchange ->
            authorization = exchange.requestHeaders.getFirst("Authorization")
            val body =
                """{"ok":true,"appVersion":"5.3.0","webApiVersion":"2.16.2"}"""
                    .toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    @Test
    fun healthUsesBearerToken() = runBlocking {
        val api = ProxyApi("http://127.0.0.1:${server.address.port}/", "test-token")

        val response = api.configuration.checkQbitConnection()

        assertTrue(response.isSuccessful)
        assertEquals("5.3.0", response.body()?.appVersion)
        assertEquals("Bearer test-token", authorization)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsNonHttpUrl() {
        ProxyApi("ftp://bridge.example", "test-token")
    }
}
