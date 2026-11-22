package dev.remagnet.app.client

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.google.gson.annotations.SerializedName
import dev.remagnet.app.data.AuthMode
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.parseHttpUrl
import dev.remagnet.app.magnet.parseMagnet
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * qBittorrent Web API v2 over OkHttp.
 *
 * API keys are sent as `Authorization: Bearer`. Username/password auth logs in
 * once, keeps the SID cookie, and retries a request once after a 401 or 403 so
 * an expired session recovers without surfacing an error.
 */
class QBittorrentClient(
    baseUrl: String,
    private val authMode: AuthMode,
    private val apiKey: String = "",
    private val username: String = "",
    private val password: String = "",
    private val http: OkHttpClient = defaultQbitHttp,
) : TorrentClient {
    private val baseUrl: String = baseUrl.trim().trimEnd('/')
    private val gson = Gson()
    private val sessionLock = Mutex()
    private var sid: String? = null

    override suspend fun testConnection(): QbitResult<ConnectionDetails> = attempt {
        requireConfiguration()
        val appVersion = getText("api/v2/app/version").trim()
        val webApiVersion = getText("api/v2/app/webapiVersion").trim()
        if (appVersion.isEmpty() || webApiVersion.isEmpty()) {
            throw QbitException(
                QbitError.InvalidResponse("qBittorrent returned empty version information."),
            )
        }
        ConnectionDetails(appVersion = appVersion, webApiVersion = webApiVersion)
    }

    override suspend fun listTorrents(): QbitResult<List<TorrentSummary>> = attempt {
        requireConfiguration()
        val body = getText(
            path = "api/v2/torrents/info",
            query = mapOf("sort" to "added_on", "reverse" to "true"),
        )
        parseTorrents(body)
    }

    override suspend fun getTorrent(hash: String): QbitResult<TorrentSummary?> = attempt {
        requireConfiguration()
        val wanted = hash.trim()
        if (wanted.isEmpty()) return@attempt null

        val body = getText(
            path = "api/v2/torrents/info",
            query = mapOf("hashes" to wanted),
        )
        parseTorrents(body).firstOrNull()
    }

    override suspend fun getTaxonomy(): QbitResult<TorrentTaxonomy> = attempt {
        requireConfiguration()
        TorrentTaxonomy(categories = getCategories(), tags = getTags().sorted())
    }

    override suspend fun addTorrent(request: AddTorrentRequest): QbitResult<AddTorrentResult> =
        attempt {
            requireConfiguration()
            if (request.urls.isEmpty()) {
                throw QbitException(
                    QbitError.InvalidSettings("No magnet or torrent URL was supplied."),
                )
            }

            val category = request.category.trim()
            val tags = normalizeTagList(request.tags)
            if (category.isNotEmpty()) ensureCategory(category)
            if (tags.isNotEmpty()) ensureTags(tags)

            val form = buildMap {
                put("urls", request.urls.joinToString("\n"))
                if (category.isNotEmpty()) put("category", category)
                if (tags.isNotEmpty()) put("tags", tags.joinToString(","))
                if (request.paused) {
                    // qBittorrent 5 reads "stopped" and still accepts "paused"
                    // from older versions.
                    put("paused", "true")
                    put("stopped", "true")
                }
            }

            val body = postForm("api/v2/torrents/add", form)
            if (body.trim().startsWith("fail", ignoreCase = true)) {
                throw QbitException(
                    QbitError.Rejected(
                        "qBittorrent did not add this torrent. It may already exist, " +
                            "or the magnet link may be invalid.",
                    ),
                )
            }

            AddTorrentResult(
                added = request.urls.size,
                hashes = request.urls.mapNotNull { parseMagnet(it)?.infoHash },
            )
        }

    override suspend fun removeTorrent(
        hashes: List<String>,
        deleteFiles: Boolean,
    ): QbitResult<Unit> = attempt {
        requireConfiguration()
        val clean = hashes.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (clean.isEmpty()) return@attempt

        postForm(
            path = "api/v2/torrents/delete",
            form = mapOf(
                "hashes" to clean.joinToString("|"),
                "deleteFiles" to deleteFiles.toString(),
            ),
        )
    }

    private suspend fun getCategories(): List<String> {
        val body = getText("api/v2/torrents/categories")
        return try {
            JsonParser.parseString(body).asJsonObject.keySet().sorted()
        } catch (_: Exception) {
            throw QbitException(
                QbitError.InvalidResponse("qBittorrent returned an unreadable category list."),
            )
        }
    }

    private suspend fun getTags(): List<String> {
        val body = getText("api/v2/torrents/tags")
        if (body.isBlank()) return emptyList()
        return try {
            gson.fromJson(body, Array<String>::class.java)?.toList().orEmpty()
        } catch (_: Exception) {
            throw QbitException(
                QbitError.InvalidResponse("qBittorrent returned an unreadable tag list."),
            )
        }
    }

    private suspend fun ensureCategory(name: String) {
        if (getCategories().any { it == name }) return
        try {
            postForm(
                path = "api/v2/torrents/createCategory",
                form = mapOf("category" to name, "savePath" to ""),
            )
        } catch (error: QbitException) {
            if (error.error is QbitError.Unauthorized) throw error
            // A concurrent add may have created it between the check and the
            // request, which is a success from this client's point of view.
            if (getCategories().none { it == name }) throw error
        }
    }

    private suspend fun ensureTags(tags: List<String>) {
        val existing = getTags().toSet()
        val missing = tags.filter { it !in existing }
        if (missing.isEmpty()) return

        try {
            postForm(
                path = "api/v2/torrents/createTags",
                form = mapOf("tags" to missing.joinToString(",")),
            )
        } catch (error: QbitException) {
            if (error.error is QbitError.Unauthorized) throw error
            val refreshed = getTags().toSet()
            if (missing.any { it !in refreshed }) throw error
        }
    }

    private fun parseTorrents(body: String): List<TorrentSummary> {
        if (body.isBlank()) {
            throw QbitException(
                QbitError.InvalidResponse("qBittorrent returned an empty torrent list."),
            )
        }
        val torrents = try {
            gson.fromJson(body, Array<TorrentDto>::class.java)
        } catch (_: Exception) {
            throw QbitException(
                QbitError.InvalidResponse("qBittorrent returned an unreadable torrent list."),
            )
        } ?: throw QbitException(
            QbitError.InvalidResponse("qBittorrent returned an empty torrent list."),
        )

        return torrents.map { it.toSummary() }
    }

    private suspend fun getText(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): String = execute(ApiRequest(Method.Get, path, query = query)).use { readBody(it) }

    private suspend fun postForm(path: String, form: Map<String, String>): String =
        execute(ApiRequest(Method.Post, path, form = form)).use { readBody(it) }

    private suspend fun execute(spec: ApiRequest, allowRetry: Boolean = true): Response {
        requireConfiguration()
        ensureSession()

        val response = withContext(Dispatchers.IO) {
            http.newCall(buildRequest(spec)).execute()
        }

        if (
            authMode == AuthMode.Password &&
            allowRetry &&
            (response.code == 401 || response.code == 403)
        ) {
            response.close()
            login(force = true)
            return execute(spec, allowRetry = false)
        }

        if (!response.isSuccessful) {
            val body = response.use { readBody(it) }
            throw QbitException(httpError(response.code, body))
        }
        return response
    }

    private suspend fun ensureSession() {
        if (authMode == AuthMode.ApiKey) return
        if (sid != null) return
        sessionLock.withLock {
            if (sid == null) performLogin()
        }
    }

    private suspend fun login(force: Boolean) {
        if (authMode == AuthMode.ApiKey) return
        sessionLock.withLock {
            if (force) sid = null
            if (sid == null) performLogin()
        }
    }

    private suspend fun performLogin() {
        val form = FormBody.Builder()
            .add("username", username)
            .add("password", password)
            .build()
        val request = Request.Builder()
            .url("$baseUrl/api/v2/auth/login")
            .header("Referer", "$baseUrl/")
            .header("Accept", "text/plain")
            .post(form)
            .build()

        val response = withContext(Dispatchers.IO) { http.newCall(request).execute() }
        response.use { result ->
            val body = readBody(result).trim()
            when {
                result.code == 403 -> throw QbitException(
                    QbitError.Unauthorized(
                        "qBittorrent refused the login. The IP may be banned after too many attempts.",
                    ),
                )

                !result.isSuccessful || body != "Ok." -> throw QbitException(
                    QbitError.Unauthorized("qBittorrent rejected the username and password."),
                )
            }

            val nextSid = result.headers.values("Set-Cookie")
                .firstNotNullOfOrNull(::extractSid)
                ?: throw QbitException(
                    QbitError.Unauthorized(
                        "qBittorrent logged in but did not return a session cookie.",
                    ),
                )
            sid = nextSid
        }
    }

    private fun buildRequest(spec: ApiRequest): Request {
        val url = "$baseUrl/${spec.path.trimStart('/')}"
            .toHttpUrl()
            .newBuilder()
            .apply {
                spec.query.forEach { (key, value) -> addQueryParameter(key, value) }
            }
            .build()

        val builder = Request.Builder()
            .url(url)
            .header("Referer", "$baseUrl/")
            .header("Accept", "application/json")

        when (authMode) {
            AuthMode.ApiKey -> builder.header("Authorization", "Bearer $apiKey")
            AuthMode.Password -> sid?.let { builder.header("Cookie", "SID=$it") }
        }

        return when (spec.method) {
            Method.Get -> builder.get().build()
            Method.Post -> {
                val body = FormBody.Builder().apply {
                    spec.form.forEach { (key, value) -> add(key, value) }
                }.build()
                builder.post(body).build()
            }
        }
    }

    private fun readBody(response: Response): String = response.body.string()

    private fun extractSid(header: String): String? {
        val pair = header.substringBefore(';').trim()
        val separator = pair.indexOf('=')
        if (separator <= 0) return null
        if (!pair.substring(0, separator).trim().equals("SID", ignoreCase = true)) return null
        return pair.substring(separator + 1).trim().takeIf { it.isNotEmpty() }
    }

    private fun requireConfiguration() {
        configurationError()?.let { throw QbitException(it) }
    }

    private fun configurationError(): QbitError? {
        if (baseUrl.isBlank()) {
            return QbitError.InvalidSettings("No qBittorrent Web UI URL is configured.")
        }
        if (parseHttpUrl(baseUrl) == null) {
            return QbitError.InvalidSettings("The qBittorrent Web UI URL is not valid.")
        }

        return when (authMode) {
            AuthMode.ApiKey -> if (apiKey.isBlank()) {
                QbitError.InvalidSettings("No qBittorrent API key is configured.")
            } else {
                null
            }

            AuthMode.Password -> when {
                username.isBlank() ->
                    QbitError.InvalidSettings("No qBittorrent username is configured.")

                password.isEmpty() ->
                    QbitError.InvalidSettings("No qBittorrent password is configured.")

                else -> null
            }
        }
    }

    private fun httpError(status: Int, body: String): QbitError {
        val detail = body.trim()
            .takeIf { it.isNotEmpty() && !it.startsWith("<") }
            ?.take(160)

        return when (status) {
            401, 403 -> QbitError.Unauthorized(
                "qBittorrent rejected the request. Check the API key or password.",
            )

            else -> QbitError.Http(
                status,
                buildString {
                    append("qBittorrent returned HTTP ")
                    append(status)
                    if (detail != null) {
                        append(": ")
                        append(detail)
                    } else {
                        append('.')
                    }
                },
            )
        }
    }

    private suspend fun <T> attempt(block: suspend () -> T): QbitResult<T> = try {
        QbitResult.Success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: QbitException) {
        QbitResult.Failure(error.error)
    } catch (_: IOException) {
        QbitResult.Failure(
            QbitError.Unreachable(
                "Could not reach qBittorrent at $baseUrl. Check the URL and network.",
            ),
        )
    } catch (_: Exception) {
        QbitResult.Failure(
            QbitError.InvalidResponse("qBittorrent returned a response Remagnet could not read."),
        )
    }

    private data class ApiRequest(
        val method: Method,
        val path: String,
        val query: Map<String, String> = emptyMap(),
        val form: Map<String, String> = emptyMap(),
    )

    private enum class Method { Get, Post }

    private class QbitException(val error: QbitError) : Exception(error.message)

    private data class TorrentDto(
        val hash: String? = null,
        val name: String? = null,
        val state: String? = null,
        val progress: Double? = null,
        val size: Long? = null,
        val dlspeed: Long? = null,
        val upspeed: Long? = null,
        val eta: Long? = null,
        val ratio: Double? = null,
        val category: String? = null,
        val tags: String? = null,
        val num_seeds: Int? = null,
        val num_leechs: Int? = null,
        @SerializedName("added_on") val addedOn: Long? = null,
    ) {
        fun toSummary(): TorrentSummary {
            val rawState = state.orEmpty()
            return TorrentSummary(
                hash = hash.orEmpty(),
                name = name.orEmpty().ifBlank { "(unnamed torrent)" },
                state = TorrentState.fromQbittorrent(rawState),
                rawState = rawState,
                progress = (progress ?: 0.0).coerceIn(0.0, 1.0),
                size = size ?: 0,
                downloadSpeed = dlspeed ?: 0,
                uploadSpeed = upspeed ?: 0,
                eta = eta ?: ETA_UNKNOWN,
                ratio = ratio ?: 0.0,
                category = category.orEmpty(),
                tags = splitTagList(tags),
                seeds = num_seeds ?: 0,
                peers = num_leechs ?: 0,
                addedOn = addedOn ?: 0,
            )
        }
    }

    companion object {
        fun from(
            settings: RemagnetSettings,
            http: OkHttpClient = defaultQbitHttp,
        ): QBittorrentClient = QBittorrentClient(
            baseUrl = settings.qbitBaseUrl,
            authMode = settings.authMode,
            apiKey = settings.qbitApiKey,
            username = settings.qbitUsername,
            password = settings.qbitPassword,
            http = http,
        )
    }
}

private val defaultQbitHttp: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        // A phone on a stale LAN address should fail in a time the screen can
        // explain, not wait out the platform default.
        .callTimeout(30, TimeUnit.SECONDS)
        .build()
}
