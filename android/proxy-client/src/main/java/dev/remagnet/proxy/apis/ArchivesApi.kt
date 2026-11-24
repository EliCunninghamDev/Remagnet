package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import okhttp3.ResponseBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.ArchiveTicket
import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.ServiceUnavailable

interface ArchivesApi {
    /**
     * POST api/archive/{hash}/ticket
     * Mint a single-use archive download ticket
     * Issues a 60-second, single-use ticket bound to this info hash. Devices use it instead of putting their long-lived token in a download URL, where it would leak into history and logs. The caller needs a device token or an administrator session; the ticket itself then authorizes exactly one &#x60;GET /archive/{hash}&#x60;.  The torrent must exist and match the proxy&#39;s configured category/tags filter, the same ownership check used by &#x60;DELETE /api/torrents/{hash}&#x60;. Unrelated or unknown hashes return &#x60;404&#x60; and never receive a ticket.
     * Responses:
     *  - 200: A ticket for one archive download.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 404: The torrent does not exist or does not match the proxy's filter.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @return [ArchiveTicket]
     */
    @POST("api/archive/{hash}/ticket")
    suspend fun createArchiveTicket(@Path("hash") hash: kotlin.String): Response<ArchiveTicket>

    /**
     * GET archive/{hash}
     * Stream a completed torrent as a ZIP
     * Looks up the torrent by info hash, requires that it is complete (progress 1, no bytes left, and not in &#x60;missingFiles&#x60; or &#x60;error&#x60;), lists its files and streams each one from qBittorrent into a stored ZIP entry. Nothing is buffered or written to disk.  The torrent must also match the proxy&#39;s configured category/tags filter, the same ownership check used by &#x60;DELETE /api/torrents/{hash}&#x60;. Unrelated and unknown hashes return &#x60;404&#x60;, whether the caller uses a token, a session or a ticket.  The response carries an exact &#x60;Content-Length&#x60;, computed from the stored ZIP layout (entry names, headers, data descriptors and the central directory) before the first upstream byte is read, including ZIP64 records when sizes or offsets exceed 4 GiB. If an upstream file stream fails after the response has started, the connection is aborted instead of ending cleanly, so browsers do not save a truncated ZIP as a completed download.
     * Responses:
     *  - 200: ZIP archive streamed as `application/zip`. Entry names are sanitized relative paths inside the torrent; directories are omitted. The suggested filename is the sanitized torrent name with a `.zip` suffix.
     *  - 400: The info hash is not 40 or 64 hexadecimal characters.
     *  - 401: Missing or invalid credentials.
     *  - 404: The torrent does not exist in qBittorrent, or it does not match the proxy's configured category/tags filter.
     *  - 409: The torrent is not complete yet, a file is still downloading, or the torrent has no files to archive.
     *  - 500: The proxy hit an unexpected internal error. The body uses `code: internal_error` and a generic message; technical detail is only written to the proxy logs.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @param ticket Single-use download ticket from &#x60;POST /api/archive/{hash}/ticket&#x60;. Alternative to a device token or administrator session; the ticket is consumed by the download and expires after 60 seconds.  (optional)
     * @return [ResponseBody]
     */
    // Keep large ZIP downloads out of memory.
    @Streaming
    @GET("archive/{hash}")
    suspend fun downloadArchive(@Path("hash") hash: kotlin.String, @Query("ticket") ticket: kotlin.String? = null): Response<ResponseBody>

}
