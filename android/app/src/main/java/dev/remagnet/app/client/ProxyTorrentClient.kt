package dev.remagnet.app.client

import com.google.gson.JsonParser
import dev.remagnet.app.data.RemagnetSettings
import dev.remagnet.app.data.parseHttpUrl
import dev.remagnet.app.proxy.ProxyApi
import dev.remagnet.proxy.models.AddTorrentRequest as ProxyAddTorrentRequest
import dev.remagnet.proxy.models.TorrentSummary as ProxyTorrentSummary
import java.io.IOException
import kotlinx.coroutines.CancellationException
import retrofit2.Response

/**
 * The proxy-backed torrent client.
 *
 * qBittorrent is reached by the proxy, so this adapter only translates the
 * generated Retrofit models into the neutral shapes the app renders and maps
 * HTTP failures into a typed [QbitResult].
 */
class ProxyTorrentClient(
    baseUrl: String,
    token: String,
    private val createApi: (baseUrl: String, token: String) -> ProxyApi = { url, value ->
        ProxyApi(url, value)
    },
) : TorrentClient {
    private val baseUrl: String = baseUrl.trim().trimEnd('/')
    private val token: String = token.trim()

    // Built lazily so a bad URL or token surfaces as a typed failure inside
    // [attempt] instead of throwing while the ViewModel constructs the client.
    private val api: ProxyApi by lazy { createApi(baseUrl, token) }

    override suspend fun testConnection(): QbitResult<ConnectionDetails> = attempt {
        requireConfiguration()
        val response = api.configuration.checkQbitConnection()
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            throw ProxyException(errorFor(response, "The Remagnet Proxy could not check qBittorrent."))
        }

        ConnectionDetails(
            clientLabel = body.clientLabel,
            appVersion = body.appVersion,
            webApiVersion = body.webApiVersion,
            pauseOnAdd = body.capabilities.pauseOnAdd,
            defaultCategory = body.defaultCategory,
            defaultTags = body.defaultTags,
        )
    }

    override suspend fun listTorrents(): QbitResult<List<TorrentSummary>> = attempt {
        requireConfiguration()
        val response = api.torrents.listTorrents()
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            throw ProxyException(errorFor(response, "The Remagnet Proxy could not read the torrent list."))
        }
        body.torrents.map { it.toModel() }
    }

    override suspend fun getTorrent(hash: String): QbitResult<TorrentSummary?> = attempt {
        requireConfiguration()
        val wanted = hash.trim()
        if (wanted.isEmpty()) return@attempt null

        val response = api.torrents.getTorrent(wanted)
        if (response.code() == 404) return@attempt null

        val body = response.body()
        if (!response.isSuccessful || body == null) {
            throw ProxyException(errorFor(response, "The Remagnet Proxy could not read that torrent."))
        }
        body.toModel()
    }

    override suspend fun addTorrent(request: AddTorrentRequest): QbitResult<AddTorrentResult> =
        attempt {
            requireConfiguration()
            if (request.urls.isEmpty()) {
                throw ProxyException(
                    QbitError.InvalidSettings("No magnet or torrent URL was supplied."),
                )
            }

            val response = api.torrents.addTorrents(
                ProxyAddTorrentRequest(urls = request.urls, paused = request.paused),
            )
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                throw ProxyException(
                    errorFor(
                        response,
                        "The Remagnet Proxy did not add this torrent. " +
                            "It may already exist, or the magnet link may be invalid.",
                    ),
                )
            }

            AddTorrentResult(
                added = body.added,
                hashes = body.hashes,
                category = body.category,
                tags = body.tags,
            )
        }

    override suspend fun removeTorrent(
        hashes: List<String>,
        deleteFiles: Boolean,
    ): QbitResult<Unit> = attempt {
        requireConfiguration()
        val clean = hashes.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (clean.isEmpty()) return@attempt

        for (hash in clean) {
            val response = api.torrents.removeTorrent(hash, deleteFiles)
            if (!response.isSuccessful) {
                throw ProxyException(
                    errorFor(response, "The Remagnet Proxy could not remove that torrent."),
                )
            }
        }
    }

    private fun requireConfiguration() {
        if (baseUrl.isBlank() || parseHttpUrl(baseUrl) == null) {
            throw ProxyException(QbitError.InvalidSettings("The Remagnet Proxy URL is not valid."))
        }
        if (token.isBlank()) {
            throw ProxyException(QbitError.InvalidSettings("No Remagnet Proxy token is configured."))
        }
    }

    private fun ProxyTorrentSummary.toModel(): TorrentSummary = TorrentSummary(
        hash = hash,
        name = name.ifBlank { "(unnamed torrent)" },
        state = TorrentState.fromProxy(state),
        rawState = state,
        progress = progress.coerceIn(0.0, 1.0),
        size = propertySize,
        downloadSpeed = downloadSpeed,
        uploadSpeed = uploadSpeed,
        eta = eta,
        ratio = ratio,
        category = category,
        tags = tags,
        seeds = seeds.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt(),
        peers = peers.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt(),
        addedOn = 0,
    )

    private fun errorFor(response: Response<*>, fallback: String): QbitError {
        val error = errorBody(response)
        val detail = error.message
        val code = error.code
        return when (response.code()) {
            401 -> QbitError.Unauthorized(
                detail ?: "The Remagnet Proxy token is missing or invalid.",
                code,
            )

            400 -> QbitError.Rejected(detail ?: fallback, code)
            404 -> QbitError.Http(
                404,
                detail ?: "The torrent does not exist or is not owned by Remagnet.",
                code,
            )

            503 -> QbitError.Http(
                503,
                detail ?: "The Remagnet Proxy has no qBittorrent credentials configured yet.",
                code,
            )

            502 -> QbitError.Http(
                502,
                detail ?: "The Remagnet Proxy could not reach qBittorrent.",
                code,
            )

            else -> QbitError.Http(
                response.code(),
                detail ?: "$fallback (HTTP ${response.code()})",
                code,
            )
        }
    }

    private data class ProxyErrorBody(val message: String? = null, val code: String? = null)

    private fun errorBody(response: Response<*>): ProxyErrorBody {
        val text = try {
            response.errorBody()?.string()
        } catch (_: IOException) {
            null
        } ?: return ProxyErrorBody()

        return try {
            val json = JsonParser.parseString(text).asJsonObject
            ProxyErrorBody(
                message = json.get("error")?.takeIf { it.isJsonPrimitive }?.asString
                    ?.trim()?.takeIf { it.isNotEmpty() },
                code = json.get("code")?.takeIf { it.isJsonPrimitive }?.asString
                    ?.trim()?.takeIf { it.isNotEmpty() },
            )
        } catch (_: Exception) {
            ProxyErrorBody()
        }
    }

    private suspend fun <T> attempt(block: suspend () -> T): QbitResult<T> = try {
        QbitResult.Success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: ProxyException) {
        QbitResult.Failure(error.error)
    } catch (error: IllegalArgumentException) {
        QbitResult.Failure(
            QbitError.InvalidSettings(
                error.message ?: "The Remagnet Proxy settings are not valid.",
            ),
        )
    } catch (error: IOException) {
        QbitResult.Failure(
            QbitError.Unreachable(
                describeProxyConnectionFailure(error, baseUrl),
            ),
        )
    } catch (_: Exception) {
        QbitResult.Failure(
            QbitError.InvalidResponse(
                "The Remagnet Proxy returned a response Remagnet could not read.",
            ),
        )
    }

    private class ProxyException(val error: QbitError) : Exception(error.message)

    companion object {
        fun from(settings: RemagnetSettings): ProxyTorrentClient =
            ProxyTorrentClient(settings.proxyBaseUrl, settings.proxyToken)
    }
}
