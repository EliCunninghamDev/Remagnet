package dev.remagnet.app.client

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ProxyTorrentClientTest {
    private lateinit var server: HttpServer
    private val authorization = AtomicReference<String?>(null)
    private val addBody = AtomicReference<String?>(null)
    private var listCode = 200
    private var addCode = 200
    private var addResponse =
        """{"added":1,"hashes":["abc123"],""" +
            """"category":"remagnet","tags":["linux"]}"""
    private var listBody = """
        {
          "torrents": [
            {
              "hash": "ABC123",
              "name": "nebula.iso",
              "state": "downloading",
              "progress": 0.42,
              "size": 4096,
              "downloadSpeed": 512,
              "uploadSpeed": 32,
              "eta": 90,
              "ratio": 0.2,
              "category": "remagnet",
              "tags": ["linux", "isos"],
              "seeds": 7,
              "peers": 3
            }
          ]
        }
    """.trimIndent()

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/torrents") { exchange ->
            authorization.set(exchange.requestHeaders.getFirst("Authorization"))
            when {
                exchange.requestMethod == "POST" -> {
                    addBody.set(exchange.requestBody.readBytes().decodeToString())
                    respond(exchange, addCode, addResponse)
                }

                exchange.requestMethod == "GET" && exchange.requestURI.path.endsWith("/missing") ->
                    respond(exchange, 404, """{"error":"Not found."}""")

                exchange.requestMethod == "GET" -> respond(exchange, listCode, listBody)
                else -> respond(exchange, 204, "")
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun client(token: String = "0123456789abcdef") = ProxyTorrentClient(
        baseUrl = "http://127.0.0.1:${server.address.port}",
        token = token,
    )

    @Test
    fun mapsTheProxyTorrentShapeAndSendsTheBearerToken() = runBlocking {
        val result = client().listTorrents()

        assertTrue(result.toString(), result is QbitResult.Success)
        val torrent = (result as QbitResult.Success).value.single()
        assertEquals("ABC123", torrent.hash)
        assertEquals("nebula.iso", torrent.name)
        assertEquals(TorrentState.Downloading, torrent.state)
        assertEquals(0.42, torrent.progress, 0.0001)
        assertEquals(4096L, torrent.size)
        assertEquals("remagnet", torrent.category)
        assertEquals(listOf("linux", "isos"), torrent.tags)
        assertEquals(7, torrent.seeds)
        assertEquals("Bearer 0123456789abcdef", authorization.get())
    }

    @Test
    fun clampsANegativeSeedCountInsteadOfCrashing() = runBlocking {
        listBody = listBody.replace("\"seeds\": 7", "\"seeds\": -1")

        val result = client().listTorrents() as QbitResult.Success

        assertEquals(0, result.value.single().seeds)
    }

    @Test
    fun addSendsOnlyUrlsAndPausedAndReturnsTheAppliedDefaults() = runBlocking {
        val request = AddTorrentRequest(
            urls = listOf("magnet:?xt=urn:btih:abc123"),
            paused = true,
        )

        val result = client().addTorrent(request)

        assertTrue(result.toString(), result is QbitResult.Success)
        val added = (result as QbitResult.Success).value
        assertEquals(1, added.added)
        assertEquals(listOf("abc123"), added.hashes)
        assertEquals("remagnet", added.category)
        assertEquals(listOf("linux"), added.tags)

        // Gson HTML-escapes "=" in the wire body, so inspect the JSON rather
        // than the raw string.
        val json = JsonParser.parseString(addBody.get().orEmpty()).asJsonObject
        assertEquals(1, json.getAsJsonArray("urls").size())
        assertEquals(
            "magnet:?xt=urn:btih:abc123",
            json.getAsJsonArray("urls")[0].asString,
        )
        assertTrue(json.get("paused").asBoolean)
        assertNull(json.get("category"))
        assertNull(json.get("tags"))
        assertNull(json.get("files"))
    }

    @Test
    fun addUploadsTorrentFileBytesAsBase64() = runBlocking {
        val bytes = byteArrayOf(0x64, 0x65, 0x01, 0x02, 0xff.toByte())
        val request = AddTorrentRequest(
            files = listOf(TorrentFileUpload(filename = "debian.torrent", bytes = bytes)),
            paused = true,
        )

        val result = client().addTorrent(request)

        assertTrue(result.toString(), result is QbitResult.Success)
        val added = (result as QbitResult.Success).value
        assertEquals(1, added.added)
        assertEquals(listOf("abc123"), added.hashes)

        val json = JsonParser.parseString(addBody.get().orEmpty()).asJsonObject
        assertNull(json.get("urls"))
        assertTrue(json.get("paused").asBoolean)
        val file = json.getAsJsonArray("files")[0].asJsonObject
        assertEquals(java.util.Base64.getEncoder().encodeToString(bytes), file.get("data").asString)
        assertEquals("debian.torrent", file.get("filename").asString)
    }

    @Test
    fun addUploadsFilesWithoutAFilenameWhenTheCallerHasNone() = runBlocking {
        val request = AddTorrentRequest(
            files = listOf(TorrentFileUpload(bytes = byteArrayOf(0x01))),
        )

        client().addTorrent(request)

        val json = JsonParser.parseString(addBody.get().orEmpty()).asJsonObject
        val file = json.getAsJsonArray("files")[0].asJsonObject
        assertNull(file.get("filename"))
        assertTrue(json.get("paused").asBoolean.not())
    }

    @Test
    fun addWithoutUrlsOrFilesFailsBeforeCallingTheNetwork() = runBlocking {
        val result = client().addTorrent(AddTorrentRequest())

        assertTrue(result is QbitResult.Failure)
        assertTrue((result as QbitResult.Failure).error is QbitError.InvalidSettings)
        assertNull(addBody.get())
    }

    @Test
    fun anOversizedUploadIsReportedAsRejected() = runBlocking {
        addCode = 413
        addResponse = """{"error":"The .torrent file is too large.","code":"too_large"}"""

        val result = client().addTorrent(
            AddTorrentRequest(files = listOf(TorrentFileUpload(bytes = byteArrayOf(0x01)))),
        )

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Rejected)
        assertEquals("The .torrent file is too large.", error.message)
        assertEquals("too_large", error.code)
    }

    @Test
    fun aMissingTorrentIsNotAnError() = runBlocking {
        assertNull((client().getTorrent("missing") as QbitResult.Success).value)
    }

    @Test
    fun anUnauthorizedTokenIsReportedSeparately() = runBlocking {
        listCode = 401
        listBody = """{"error":"Missing or invalid proxy token.","code":"unauthorized"}"""

        val result = client().listTorrents()

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Unauthorized)
        assertEquals("Missing or invalid proxy token.", error.message)
        assertEquals("unauthorized", error.code)
    }

    @Test
    fun keepsTheProxyErrorCodeForOtherFailures() = runBlocking {
        listCode = 502
        listBody = """{"error":"qBittorrent is offline.","code":"qbit_unreachable"}"""

        val result = client().listTorrents()

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(502, (error as QbitError.Http).status)
        assertEquals("qBittorrent is offline.", error.message)
        assertEquals("qbit_unreachable", error.code)
    }

    @Test
    fun aMissingProxyTokenFailsWithoutCallingTheNetwork() = runBlocking {
        val result = client(token = "").listTorrents()

        assertTrue(result is QbitResult.Failure)
        assertTrue((result as QbitResult.Failure).error is QbitError.InvalidSettings)
        assertNull(authorization.get())
    }

    @Test
    fun anUnreachableProxyIsReported() = runBlocking {
        val closedPort = ServerSocket(0).use { it.localPort }
        val offline = ProxyTorrentClient(
            baseUrl = "http://127.0.0.1:$closedPort",
            token = "0123456789abcdef",
        )

        val result = offline.listTorrents()

        assertTrue(result is QbitResult.Failure)
        assertTrue((result as QbitResult.Failure).error is QbitError.Unreachable)
    }

    private fun respond(exchange: HttpExchange, code: Int, body: String) {
        val bytes = body.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
