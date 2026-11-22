package dev.remagnet.app.client

import com.google.gson.Gson
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URLDecoder

/**
 * A small in-process qBittorrent that speaks the Web API subset the app uses.
 *
 * It behaves like the real server where the client cares: API-key and SID
 * authentication, form posts, category and tag creation, torrent JSON, and the
 * `"Fails."` body qBittorrent returns when it rejects a magnet.
 */
internal class FakeQBittorrentServer {
    data class RecordedRequest(
        val method: String,
        val path: String,
        val authorization: String?,
        val cookie: String?,
        val query: Map<String, String>,
        val form: Map<String, String>,
    )

    data class TorrentPayload(
        val hash: String,
        val name: String,
        val state: String,
        val progress: Double,
        val size: Long,
        val dlspeed: Long,
        val upspeed: Long,
        val eta: Long,
        val ratio: Double,
        val category: String,
        val tags: String,
        val num_seeds: Int,
        val num_leechs: Int,
        val added_on: Long,
    )

    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val gson = Gson()

    val requests = mutableListOf<RecordedRequest>()

    var validApiKey = "qbt_test_key"
    var validUsername = "admin"
    var validPassword = "secret"
    var appVersion = "v5.1.2"
    var webApiVersion = "2.11.4"
    var categories: MutableSet<String> = linkedSetOf("remagnet")
    var tags: MutableSet<String> = linkedSetOf("remagnet", "linux")
    var torrents: MutableList<TorrentPayload> = mutableListOf(defaultTorrent())
    var addResponse = "Ok."
    var loginHttpStatus = 200
    var failNextInfoWith: Int? = null
    var infoBodyOverride: String? = null

    var loginCount = 0
        private set

    private var sidCounter = 0
    private var currentSid: String? = null

    val baseUrl: String
        get() = "http://127.0.0.1:${server.address.port}"

    init {
        server.createContext("/") { exchange -> handle(exchange) }
        server.start()
    }

    fun close() {
        server.stop(0)
    }

    private fun handle(exchange: HttpExchange) {
        try {
            val path = exchange.requestURI.path
            val query = parsePairs(exchange.requestURI.rawQuery)
            val form = if (exchange.requestMethod == "POST") {
                parsePairs(exchange.requestBody.reader().readText())
            } else {
                emptyMap()
            }
            val request = RecordedRequest(
                method = exchange.requestMethod,
                path = path,
                authorization = exchange.requestHeaders.getFirst("Authorization"),
                cookie = exchange.requestHeaders.getFirst("Cookie"),
                query = query,
                form = form,
            )
            requests += request

            if (path == "/api/v2/auth/login") {
                handleLogin(exchange, form)
                return
            }

            if (!isAuthorized(request)) {
                respondText(exchange, 401, "Unauthorized")
                return
            }

            when (path) {
                "/api/v2/app/version" -> respondText(exchange, 200, appVersion)
                "/api/v2/app/webapiVersion" -> respondText(exchange, 200, webApiVersion)

                "/api/v2/torrents/info" -> {
                    val failure = failNextInfoWith
                    if (failure != null) {
                        failNextInfoWith = null
                        respondText(exchange, failure, "Unauthorized")
                        return
                    }

                    val override = infoBodyOverride
                    if (override != null) {
                        respondText(exchange, 200, override, "application/json")
                        return
                    }

                    val wanted = query["hashes"]?.split('|')?.filter { it.isNotEmpty() }
                    val list = if (wanted == null) {
                        torrents
                    } else {
                        torrents.filter { it.hash in wanted }
                    }
                    respondText(exchange, 200, gson.toJson(list), "application/json")
                }

                "/api/v2/torrents/categories" -> respondText(
                    exchange,
                    200,
                    gson.toJson(
                        categories.associateWith { mapOf("name" to it, "savePath" to "") },
                    ),
                    "application/json",
                )

                "/api/v2/torrents/tags" -> respondText(
                    exchange,
                    200,
                    gson.toJson(tags.toList()),
                    "application/json",
                )

                "/api/v2/torrents/createCategory" -> {
                    form["category"]?.takeIf { it.isNotEmpty() }?.let { categories += it }
                    respondEmpty(exchange)
                }

                "/api/v2/torrents/createTags" -> {
                    form["tags"]
                        ?.split(',')
                        ?.map { it.trim() }
                        ?.filter { it.isNotEmpty() }
                        ?.forEach { tags += it }
                    respondEmpty(exchange)
                }

                "/api/v2/torrents/add" -> respondText(exchange, 200, addResponse)
                "/api/v2/torrents/delete" -> respondEmpty(exchange)

                else -> respondText(exchange, 404, "Not found")
            }
        } catch (error: Exception) {
            runCatching { respondText(exchange, 500, error.message.orEmpty()) }
        }
    }

    private fun handleLogin(exchange: HttpExchange, form: Map<String, String>) {
        loginCount += 1

        if (loginHttpStatus != 200) {
            respondText(exchange, loginHttpStatus, "Your IP has been banned")
            return
        }

        val accepted = form["username"] == validUsername && form["password"] == validPassword
        if (!accepted) {
            respondText(exchange, 200, "Fails.")
            return
        }

        val sid = "sid-${++sidCounter}"
        currentSid = sid
        exchange.responseHeaders.add("Set-Cookie", "SID=$sid; HttpOnly; path=/")
        respondText(exchange, 200, "Ok.")
    }

    private fun isAuthorized(request: RecordedRequest): Boolean {
        if (request.authorization == "Bearer $validApiKey") return true
        val sid = currentSid ?: return false
        return request.cookie == "SID=$sid"
    }

    private fun respondText(
        exchange: HttpExchange,
        status: Int,
        body: String,
        contentType: String = "text/plain",
    ) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("Content-Type", contentType)
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun respondEmpty(exchange: HttpExchange) {
        exchange.sendResponseHeaders(200, -1)
        exchange.close()
    }

    private fun parsePairs(raw: String?): Map<String, String> {
        if (raw.isNullOrBlank()) return emptyMap()
        return raw
            .split('&')
            .filter { it.isNotEmpty() }
            .mapNotNull { pair ->
                val separator = pair.indexOf('=')
                if (separator <= 0) {
                    null
                } else {
                    decode(pair.substring(0, separator)) to decode(pair.substring(separator + 1))
                }
            }
            .toMap()
    }

    private fun decode(value: String): String =
        runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)

    companion object {
        fun defaultTorrent() = TorrentPayload(
            hash = "0123456789abcdef0123456789abcdef01234567",
            name = "Ubuntu ISO",
            state = "stalledUP",
            progress = 1.0,
            size = 4_294_967_296,
            dlspeed = 0,
            upspeed = 2048,
            eta = 8_640_000,
            ratio = 1.5,
            category = "remagnet",
            tags = "remagnet, linux",
            num_seeds = 3,
            num_leechs = 4,
            added_on = 1_700_000_000,
        )
    }
}
