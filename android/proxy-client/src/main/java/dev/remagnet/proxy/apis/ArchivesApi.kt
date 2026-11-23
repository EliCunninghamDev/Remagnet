package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import okhttp3.ResponseBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.ServiceUnavailable

interface ArchivesApi {
    /**
     * GET archive/{hash}
     * Stream a completed torrent as a ZIP
     * Looks up the torrent by info hash, requires that it is complete (progress 1, no bytes left, and not in &#x60;missingFiles&#x60; or &#x60;error&#x60;), lists its files and streams each one from qBittorrent into a stored ZIP entry. Nothing is buffered or written to disk.  The response has no &#x60;Content-Length&#x60; because the archive is produced while it is downloaded. If an upstream file stream fails after the response has started, the connection is aborted instead of ending cleanly, so browsers do not save a truncated ZIP as a completed download.
     * Responses:
     *  - 200: ZIP archive streamed as `application/zip`. Entry names are sanitized relative paths inside the torrent; directories are omitted. The suggested filename is the sanitized torrent name with a `.zip` suffix.
     *  - 400: The info hash is not 40 or 64 hexadecimal characters.
     *  - 401: Missing or invalid proxy token.
     *  - 404: No torrent with that hash exists in qBittorrent.
     *  - 409: The torrent is not complete yet, a file is still downloading, or the torrent has no files to archive.
     *  - 500: The proxy could not save configuration or start the archive.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [ResponseBody]
     */
    // Keep large ZIP downloads out of memory.
    @Streaming
    @GET("archive/{hash}")
    suspend fun downloadArchive(@Path("hash") hash: kotlin.String, @Query("token") token: kotlin.String? = null): Response<ResponseBody>

}
