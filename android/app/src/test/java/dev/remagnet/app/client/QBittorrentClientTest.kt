package dev.remagnet.app.client

import dev.remagnet.app.data.AuthMode
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class QBittorrentClientTest {
    private lateinit var server: FakeQBittorrentServer

    private val http = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    @Before
    fun setUp() {
        server = FakeQBittorrentServer()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun apiKeyClient(key: String = server.validApiKey) = QBittorrentClient(
        baseUrl = server.baseUrl,
        authMode = AuthMode.ApiKey,
        apiKey = key,
        http = http,
    )

    private fun passwordClient(password: String = server.validPassword) = QBittorrentClient(
        baseUrl = server.baseUrl,
        authMode = AuthMode.Password,
        username = server.validUsername,
        password = password,
        http = http,
    )

    @Test
    fun apiKeyConnectionReportsVersionsAndSendsBearer() = runBlocking {
        val result = apiKeyClient().testConnection()

        val details = result.success()
        assertEquals("v5.1.2", details.appVersion)
        assertEquals("2.11.4", details.webApiVersion)
        assertTrue(server.requests.none { it.path == "/api/v2/auth/login" })
        assertTrue(
            server.requests
                .filter { it.path.startsWith("/api/v2/") }
                .all { it.authorization == "Bearer ${server.validApiKey}" },
        )
    }

    @Test
    fun passwordAuthLogsInOnceAndReusesTheSessionCookie() = runBlocking {
        val result = passwordClient().listTorrents()

        result.success()
        assertEquals(1, server.loginCount)
        val info = server.requests.last { it.path == "/api/v2/torrents/info" }
        assertEquals("SID=sid-1", info.cookie)
        assertNull(info.authorization)
    }

    @Test
    fun passwordAuthReLogsInAfterAnExpiredSession() = runBlocking {
        val client = passwordClient()
        client.testConnection().success()

        server.failNextInfoWith = 401
        val result = client.listTorrents()

        result.success()
        assertEquals(2, server.loginCount)
        val lastInfo = server.requests.last { it.path == "/api/v2/torrents/info" }
        assertEquals("SID=sid-2", lastInfo.cookie)
    }

    @Test
    fun wrongPasswordMapsToUnauthorized() = runBlocking {
        val error = passwordClient(password = "wrong").testConnection().failure()

        assertTrue(error is QbitError.Unauthorized)
        assertEquals(1, server.loginCount)
    }

    @Test
    fun bannedLoginMapsToUnauthorized() = runBlocking {
        server.loginHttpStatus = 403

        val error = passwordClient().testConnection().failure()

        assertTrue(error is QbitError.Unauthorized)
        assertTrue(error.message.contains("banned"))
    }

    @Test
    fun wrongApiKeyMapsToUnauthorized() = runBlocking {
        val error = apiKeyClient(key = "wrong").testConnection().failure()

        assertTrue(error is QbitError.Unauthorized)
    }

    @Test
    fun unreachableHostMapsToUnreachable() = runBlocking {
        val closedPort = ServerSocket(0).use { it.localPort }
        val client = QBittorrentClient(
            baseUrl = "http://127.0.0.1:$closedPort",
            authMode = AuthMode.ApiKey,
            apiKey = "qbt_test_key",
            http = http,
        )

        val error = client.testConnection().failure()

        assertTrue(error is QbitError.Unreachable)
    }

    @Test
    fun invalidConfigurationDoesNotTouchTheNetwork() = runBlocking {
        val client = QBittorrentClient(
            baseUrl = server.baseUrl,
            authMode = AuthMode.ApiKey,
            apiKey = "",
            http = http,
        )

        val error = client.listTorrents().failure()

        assertTrue(error is QbitError.InvalidSettings)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun listsAndMapsTorrents() = runBlocking {
        val torrents = apiKeyClient().listTorrents().success()

        assertEquals(1, torrents.size)
        val torrent = torrents.single()
        assertEquals("0123456789abcdef0123456789abcdef01234567", torrent.hash)
        assertEquals("Ubuntu ISO", torrent.name)
        assertEquals(TorrentState.Seeding, torrent.state)
        assertEquals("stalledUP", torrent.rawState)
        assertEquals(1.0, torrent.progress, 0.0)
        assertEquals(4_294_967_296L, torrent.size)
        assertEquals(2048L, torrent.uploadSpeed)
        assertEquals(listOf("remagnet", "linux"), torrent.tags)
        assertEquals(3, torrent.seeds)
        assertEquals(4, torrent.peers)
        assertTrue(torrent.isComplete)

        val info = server.requests.last { it.path == "/api/v2/torrents/info" }
        assertEquals("added_on", info.query["sort"])
        assertEquals("true", info.query["reverse"])
    }

    @Test
    fun getTorrentReturnsNullWhenTheHashIsNotPresent() = runBlocking {
        val result = apiKeyClient().getTorrent("ffffffffffffffffffffffffffffffffffffffff")

        assertNull(result.success())
    }

    @Test
    fun getTorrentReturnsTheMatchingTorrent() = runBlocking {
        val hash = server.torrents.single().hash

        val torrent = apiKeyClient().getTorrent(hash).success()

        assertNotNull(torrent)
        assertEquals(hash, torrent?.hash)
        val info = server.requests.last { it.path == "/api/v2/torrents/info" }
        assertEquals(hash, info.query["hashes"])
    }

    @Test
    fun addCreatesCategoryAndTagsThenPostsTheMagnet() = runBlocking {
        server.categories.clear()
        server.tags.clear()
        val hash = "0123456789abcdef0123456789abcdef01234567"
        val magnet = "magnet:?xt=urn:btih:$hash&dn=Ubuntu+ISO"

        val result = apiKeyClient().addTorrent(
            AddTorrentRequest(
                urls = listOf(magnet),
                category = "remagnet",
                tags = listOf(" remagnet ", "linux", "linux"),
                paused = true,
            ),
        )

        val added = result.success()
        assertEquals(1, added.added)
        assertEquals(listOf(hash), added.hashes)

        val createCategory = server.requests.single {
            it.path == "/api/v2/torrents/createCategory"
        }
        assertEquals("remagnet", createCategory.form["category"])
        val createTags = server.requests.single { it.path == "/api/v2/torrents/createTags" }
        assertEquals("remagnet,linux", createTags.form["tags"])

        val add = server.requests.last { it.path == "/api/v2/torrents/add" }
        assertEquals(magnet, add.form["urls"])
        assertEquals("remagnet", add.form["category"])
        assertEquals("remagnet,linux", add.form["tags"])
        assertEquals("true", add.form["paused"])
        assertEquals("true", add.form["stopped"])
        assertTrue("remagnet" in server.categories)
        assertEquals(setOf("remagnet", "linux"), server.tags)
    }

    @Test
    fun addSkipsCategoryCreationWhenItAlreadyExists() = runBlocking {
        val result = apiKeyClient().addTorrent(
            AddTorrentRequest(
                urls = listOf("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"),
                category = "remagnet",
                tags = listOf("remagnet"),
            ),
        )

        result.success()
        assertTrue(server.requests.none { it.path == "/api/v2/torrents/createCategory" })
        assertTrue(server.requests.none { it.path == "/api/v2/torrents/createTags" })
    }

    @Test
    fun addRejectionMapsToRejected() = runBlocking {
        server.addResponse = "Fails."

        val error = apiKeyClient().addTorrent(
            AddTorrentRequest(urls = listOf("magnet:?xt=urn:btih:not-a-real-hash")),
        ).failure()

        assertTrue(error is QbitError.Rejected)
        assertTrue(error.message.contains("already exist"))
    }

    @Test
    fun removeSendsHashesAndTheDeleteChoice() = runBlocking {
        val result = apiKeyClient().removeTorrent(
            hashes = listOf("abc", "def", "abc"),
            deleteFiles = true,
        )

        result.success()
        val delete = server.requests.last { it.path == "/api/v2/torrents/delete" }
        assertEquals("abc|def", delete.form["hashes"])
        assertEquals("true", delete.form["deleteFiles"])
    }

    @Test
    fun removeWithNoHashesDoesNotCallTheServer() = runBlocking {
        val before = server.requests.size

        apiKeyClient().removeTorrent(emptyList(), deleteFiles = false).success()

        assertEquals(before, server.requests.size)
    }

    @Test
    fun taxonomyIsSortedByName() = runBlocking {
        server.categories = linkedSetOf("zeta", "alpha")
        server.tags = linkedSetOf("b-tag", "a-tag")

        val taxonomy = apiKeyClient().getTaxonomy().success()

        assertEquals(listOf("alpha", "zeta"), taxonomy.categories)
        assertEquals(listOf("a-tag", "b-tag"), taxonomy.tags)
    }

    @Test
    fun unreadableTorrentJsonMapsToInvalidResponse() = runBlocking {
        server.infoBodyOverride = "not json"

        val error = apiKeyClient().listTorrents().failure()

        assertTrue(error is QbitError.InvalidResponse)
    }

    @Test
    fun serverErrorMapsToHttp() = runBlocking {
        server.failNextInfoWith = 500

        val error = apiKeyClient().listTorrents().failure()

        assertTrue(error is QbitError.Http)
        assertEquals(500, (error as QbitError.Http).status)
    }
}

private fun <T> QbitResult<T>.success(): T {
    assertTrue("expected success but was $this", this is QbitResult.Success)
    return (this as QbitResult.Success).value
}

private fun <T> QbitResult<T>.failure(): QbitError {
    assertTrue("expected failure but was $this", this is QbitResult.Failure)
    return (this as QbitResult.Failure).error
}
