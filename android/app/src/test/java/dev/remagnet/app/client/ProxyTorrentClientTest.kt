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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ProxyTorrentClientTest {
    private lateinit var server: HttpServer
    private val authorization = AtomicReference<String?>(null)
    private val addBody = AtomicReference<String?>(null)
    private val requestPath = AtomicReference<String?>(null)
    private var listCode = 200
    private var filesCode = 200
    private var addCode = 200
    private var pauseCode = 204
    private var pauseBody = ""
    private var resumeCode = 204
    private var resumeBody = ""
    private var pauseAllCode = 204
    private var pauseAllBody = ""
    private var resumeAllCode = 204
    private var resumeAllBody = ""
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
    private var filesBody = """
        {
          "files": [
            {
              "index": 0,
              "name": "Show/Season 1/Episode.mkv",
              "size": 1048576,
              "progress": 1.0
            },
            {
              "index": 1,
              "name": "Show/Season 1/Extra.iso",
              "size": 2048,
              "progress": 0.5
            }
          ]
        }
    """.trimIndent()

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/torrents") { exchange ->
            authorization.set(exchange.requestHeaders.getFirst("Authorization"))
            requestPath.set(exchange.requestURI.path)
            val path = exchange.requestURI.path
            when {
                exchange.requestMethod == "POST" && path == "/api/torrents/pause" ->
                    respond(exchange, pauseAllCode, pauseAllBody)

                exchange.requestMethod == "POST" && path == "/api/torrents/resume" ->
                    respond(exchange, resumeAllCode, resumeAllBody)

                exchange.requestMethod == "POST" && path.endsWith("/pause") ->
                    respond(exchange, pauseCode, pauseBody)

                exchange.requestMethod == "POST" && path.endsWith("/resume") ->
                    respond(exchange, resumeCode, resumeBody)

                exchange.requestMethod == "POST" -> {
                    addBody.set(exchange.requestBody.readBytes().decodeToString())
                    respond(exchange, addCode, addResponse)
                }

                exchange.requestMethod == "GET" && exchange.requestURI.path.endsWith("/missing") ->
                    respond(exchange, 404, """{"error":"Not found."}""")

                exchange.requestMethod == "GET" && exchange.requestURI.path.endsWith("/files") ->
                    respond(exchange, filesCode, filesBody)

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
    fun listsAndMapsTheFilesInATorrent() = runBlocking {
        val result = client().listTorrentFiles("  abc123  ")

        assertTrue(result.toString(), result is QbitResult.Success)
        val files = (result as QbitResult.Success).value
        assertEquals(2, files.size)

        val first = files[0]
        assertEquals(0L, first.index)
        assertEquals("Show/Season 1/Episode.mkv", first.name)
        assertEquals("Episode.mkv", first.displayName)
        assertEquals(1048576L, first.size)
        assertEquals(1.0, first.progress, 0.0001)
        assertTrue(first.isComplete)

        val second = files[1]
        assertEquals(1L, second.index)
        assertEquals("Extra.iso", second.displayName)
        assertEquals(2048L, second.size)
        assertFalse(second.isComplete)

        assertEquals("/api/torrents/abc123/files", requestPath.get())
        assertEquals("Bearer 0123456789abcdef", authorization.get())
    }

    @Test
    fun aMissingTorrentHasNoFileList() = runBlocking {
        filesCode = 404
        filesBody = """{"error":"Torrent not found."}"""

        val result = client().listTorrentFiles("deadbeef")

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(404, (error as QbitError.Http).status)
        assertEquals("Torrent not found.", error.message)
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

    @Test
    fun pauseTorrentPostsTheTrimmedHash() = runBlocking {
        val result = client().pauseTorrent("  abc123  ")

        assertTrue(result.toString(), result is QbitResult.Success)
        assertEquals("/api/torrents/abc123/pause", requestPath.get())
    }

    @Test
    fun resumeTorrentPostsTheTrimmedHash() = runBlocking {
        val result = client().resumeTorrent("  abc123  ")

        assertTrue(result.toString(), result is QbitResult.Success)
        assertEquals("/api/torrents/abc123/resume", requestPath.get())
    }

    @Test
    fun pauseAllTorrentsPostsTheBulkPausePath() = runBlocking {
        val result = client().pauseAllTorrents()

        assertTrue(result.toString(), result is QbitResult.Success)
        assertEquals("/api/torrents/pause", requestPath.get())
    }

    @Test
    fun resumeAllTorrentsPostsTheBulkResumePath() = runBlocking {
        val result = client().resumeAllTorrents()

        assertTrue(result.toString(), result is QbitResult.Success)
        assertEquals("/api/torrents/resume", requestPath.get())
    }

    @Test
    fun pausingAMissingTorrentIsReportedAsNotFound() = runBlocking {
        pauseCode = 404
        pauseBody = """{"error":"That torrent is not owned by Remagnet."}"""

        val result = client().pauseTorrent("abc123")

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(404, (error as QbitError.Http).status)
        assertEquals("That torrent is not owned by Remagnet.", error.message)
    }

    @Test
    fun resumingAMissingTorrentIsReportedAsNotFound() = runBlocking {
        resumeCode = 404
        resumeBody = """{"error":"That torrent is not owned by Remagnet."}"""

        val result = client().resumeTorrent("abc123")

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(404, (error as QbitError.Http).status)
        assertEquals("That torrent is not owned by Remagnet.", error.message)
    }

    @Test
    fun bulkPauseKeepsTheProxyFailure() = runBlocking {
        pauseAllCode = 503
        pauseAllBody = """{"error":"No torrent client is configured.","code":"not_configured"}"""

        val result = client().pauseAllTorrents()

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(503, (error as QbitError.Http).status)
        assertEquals("not_configured", error.code)
    }

    @Test
    fun bulkResumeKeepsTheProxyFailure() = runBlocking {
        resumeAllCode = 503
        resumeAllBody = """{"error":"No torrent client is configured.","code":"not_configured"}"""

        val result = client().resumeAllTorrents()

        assertTrue(result is QbitResult.Failure)
        val error = (result as QbitResult.Failure).error
        assertTrue(error is QbitError.Http)
        assertEquals(503, (error as QbitError.Http).status)
        assertEquals("not_configured", error.code)
    }

    @Test
    fun blankHashesDoNotCallTheNetwork() = runBlocking {
        val blankPause = client().pauseTorrent("   ")
        val blankResume = client().resumeTorrent("")

        assertTrue(blankPause is QbitResult.Success)
        assertTrue(blankResume is QbitResult.Success)
        assertNull(requestPath.get())
        assertNull(authorization.get())
    }

    private fun respond(exchange: HttpExchange, code: Int, body: String) {
        val bytes = body.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        if (code == 204) {
            exchange.sendResponseHeaders(code, -1)
            exchange.close()
        } else {
            exchange.sendResponseHeaders(code, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }
}
