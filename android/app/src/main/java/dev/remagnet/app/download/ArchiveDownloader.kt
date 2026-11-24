package dev.remagnet.app.download

import com.google.gson.JsonParser
import dev.remagnet.app.client.describeProxyConnectionFailure
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/** Result of opening the proxy's streaming archive endpoint. */
sealed interface ArchiveOpenResult {
    data class Ready(
        val stream: InputStream,
        val suggestedName: String?,
        val contentLength: Long,
    ) : ArchiveOpenResult

    data class Failed(val message: String) : ArchiveOpenResult
}

/**
 * Open `GET /archive/:hash` with the bearer token in a header.
 *
 * The proxy streams the ZIP while it reads the torrent from qBittorrent, so
 * there is usually no `Content-Length`. The caller keeps the stream and closes
 * it, which also closes the response.
 */
class ArchiveDownloader(
    baseUrl: String,
    private val token: String,
    private val http: OkHttpClient = defaultArchiveHttp,
) {
    private val baseUrl = baseUrl.trim().trimEnd('/')

    fun open(hash: String): ArchiveOpenResult {
        val clean = hash.trim()
        if (!ARCHIVE_HASH.matches(clean)) {
            return ArchiveOpenResult.Failed("The torrent info hash is not valid.")
        }

        val request = Request.Builder()
            .url("$baseUrl/archive/$clean")
            .header("Authorization", "Bearer ${token.trim()}")
            .header("Accept", "application/zip")
            .get()
            .build()

        val response = try {
            http.newCall(request).execute()
        } catch (error: IOException) {
            return ArchiveOpenResult.Failed(
                describeProxyConnectionFailure(error, baseUrl),
            )
        } catch (error: Exception) {
            return ArchiveOpenResult.Failed(
                error.message ?: "Could not reach the Remagnet Proxy at $baseUrl.",
            )
        }

        if (!response.isSuccessful) {
            val detail = runCatching { response.body.string() }.getOrNull()
            val status = response.code
            response.close()
            return ArchiveOpenResult.Failed(archiveErrorMessage(status, detail))
        }

        val body = response.body
        return ArchiveOpenResult.Ready(
            stream = body.byteStream(),
            suggestedName = fileNameFromDisposition(response.header("Content-Disposition")),
            contentLength = body.contentLength(),
        )
    }

    private companion object {
        val ARCHIVE_HASH = Regex("^[0-9a-f]{40}$|^[0-9a-f]{64}$", RegexOption.IGNORE_CASE)
    }
}

/** A message that tells the user what to do about each documented status. */
fun archiveErrorMessage(status: Int, detail: String? = null): String {
    val clean = detail?.trim()
    proxyErrorMessage(clean)?.let { return it }

    val base = when (status) {
        400 -> "The Remagnet Proxy rejected that info hash."
        401 -> "The Remagnet Proxy rejected the token. Check the token in Settings."
        404 -> "qBittorrent does not have a torrent with that hash."
        409 -> "That torrent is not complete yet. Wait for it to finish, then try again."
        429 -> "The Remagnet Proxy is busy. Try again in a moment."
        500 -> "The Remagnet Proxy could not start the archive."
        502 -> "The Remagnet Proxy could not reach qBittorrent."
        else -> "The Remagnet Proxy returned HTTP $status while creating the archive."
    }

    if (status != 500 && status != 502) return base
    val text = clean
        ?.takeIf { it.isNotEmpty() && !it.startsWith("<") && !it.startsWith("{") }
        ?.take(180)
    return if (text == null) base else "$base $text"
}

/** The proxy reports failures as `{"error": "..."}`; prefer that over a fallback. */
private fun proxyErrorMessage(detail: String?): String? {
    if (detail.isNullOrEmpty() || !detail.startsWith("{")) return null
    return try {
        JsonParser.parseString(detail).asJsonObject.get("error")
            ?.takeIf { it.isJsonPrimitive }
            ?.asString
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }
}

private val defaultArchiveHttp: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // The archive is produced while it is read; a long torrent or a slow
        // disk must not trip a read timeout mid-stream.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
}
