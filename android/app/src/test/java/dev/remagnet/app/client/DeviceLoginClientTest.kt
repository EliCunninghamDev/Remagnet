package dev.remagnet.app.client

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DeviceLoginClientTest {
    private lateinit var server: HttpServer
    private var responseStatus = 200
    private var responseBody = ""
    private var receivedBody = ""
    private var receivedAuthorization: String? = null
    private var receivedMethod = ""

    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/auth/device") { exchange ->
            receivedMethod = exchange.requestMethod
            receivedAuthorization = exchange.requestHeaders.getFirst("Authorization")
            receivedBody = exchange.requestBody.readBytes().decodeToString()

            val bytes = responseBody.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(responseStatus, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun baseUrl() = "http://127.0.0.1:${server.address.port}"

    private fun body() = JsonParser.parseString(receivedBody).asJsonObject

    private fun signedInBody(name: String = "Pixel 9") = """
        {
          "token": "rmg_test-token-value",
          "device": {
            "id": "device-1",
            "name": "$name",
            "createdAt": 1700000000,
            "lastUsedAt": null
          }
        }
    """.trimIndent()

    @Test
    fun signsInAndMintsAPerDeviceToken() = runBlocking {
        responseBody = signedInBody()

        val result = DeviceLoginClient(http, defaultDeviceName = "Android").signIn(
            proxyBaseUrl = "${baseUrl()}/",
            username = "admin",
            password = "correct horse battery staple",
            deviceName = "Pixel 9",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.SignedIn)
        result as DeviceLoginResult.SignedIn
        assertEquals(baseUrl(), result.proxyBaseUrl)
        assertEquals("rmg_test-token-value", result.token)
        assertEquals("Pixel 9", result.deviceName)

        assertEquals("POST", receivedMethod)
        // This request replaces an existing token, so it must not carry one.
        assertNull(receivedAuthorization)
        assertEquals("admin", body()["username"].asString)
        assertEquals("correct horse battery staple", body()["password"].asString)
        assertEquals("Pixel 9", body()["deviceName"].asString)
        assertTrue(!receivedBody.contains("totpCode"))
    }

    @Test
    fun reportsWhenATwoFactorCodeIsRequired() = runBlocking {
        responseStatus = 401
        responseBody = """
            {"error":"Two-factor authentication code required.","code":"totp_required"}
        """.trimIndent()

        val result = DeviceLoginClient(http).signIn(
            proxyBaseUrl = baseUrl(),
            username = "admin",
            password = "correct horse battery staple",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.TotpRequired)
        assertEquals(
            "Two-factor authentication code required.",
            (result as DeviceLoginResult.TotpRequired).message,
        )
    }

    @Test
    fun reportsInvalidCredentialsWithoutEchoingThem() = runBlocking {
        responseStatus = 401
        responseBody = """{"error":"Authentication required."}"""

        val result = DeviceLoginClient(http).signIn(
            proxyBaseUrl = baseUrl(),
            username = "admin",
            password = "wrong-password",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.Failed)
        assertEquals(
            "The username or password is incorrect.",
            (result as DeviceLoginResult.Failed).message,
        )
    }

    @Test
    fun reportsARejectedTwoFactorCodeAsCredentialsFailure() = runBlocking {
        responseStatus = 401
        responseBody = """{"error":"Authentication required."}"""

        val result = DeviceLoginClient(http).signIn(
            proxyBaseUrl = baseUrl(),
            username = "admin",
            password = "correct horse battery staple",
            totpCode = "000000",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.Failed)
        assertEquals(
            "The username, password, or two-factor code is incorrect.",
            (result as DeviceLoginResult.Failed).message,
        )
    }

    @Test
    fun reportsThrottlingWithTheProxyMessage() = runBlocking {
        responseStatus = 429
        responseBody = """
            {"error":"Too many sign-in attempts. Try again in 300 seconds."}
        """.trimIndent()

        val result = DeviceLoginClient(http).signIn(
            proxyBaseUrl = baseUrl(),
            username = "admin",
            password = "wrong-password",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.Failed)
        assertEquals(
            "Too many sign-in attempts. Try again in 300 seconds.",
            (result as DeviceLoginResult.Failed).message,
        )
    }

    @Test
    fun sendsASafeDefaultDeviceNameWhenNoneIsTyped() = runBlocking {
        responseBody = signedInBody(name = "Android")

        val result = DeviceLoginClient(http, defaultDeviceName = "Android").signIn(
            proxyBaseUrl = baseUrl(),
            username = "admin",
            password = "correct horse battery staple",
            deviceName = "   ",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.SignedIn)
        assertEquals("Android", (result as DeviceLoginResult.SignedIn).deviceName)
        assertEquals("Android", body()["deviceName"].asString)
    }

    @Test
    fun rejectsAnInvalidProxyUrlBeforeCallingTheNetwork() = runBlocking {
        val result = DeviceLoginClient(http).signIn(
            proxyBaseUrl = "ftp://remagnet.example.com",
            username = "admin",
            password = "correct horse battery staple",
        )

        assertTrue(result.toString(), result is DeviceLoginResult.Failed)
        assertTrue(
            (result as DeviceLoginResult.Failed).message.contains("valid http:// or https://"),
        )
    }
}
