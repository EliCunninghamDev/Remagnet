package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.AddTorrentRequest
import dev.remagnet.proxy.models.AddTorrentResult
import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.ServiceUnavailable
import dev.remagnet.proxy.models.TorrentList
import dev.remagnet.proxy.models.TorrentSummary

interface TorrentsApi {
    /**
     * POST api/torrents
     * Add magnets, torrent URLs, or uploaded .torrent files
     * Adds the submitted torrents to the configured client with the proxy&#39;s category and tags. Send at least one entry in &#x60;urls&#x60; or &#x60;files&#x60;; a request where both are empty returns &#x60;400&#x60;. Clients cannot override the category or tags. A non-empty category is created first when missing, as are missing tags. With &#x60;paused: true&#x60; the proxy adds the torrents stopped.  &#x60;urls&#x60; accepts &#x60;magnet:&#x60; links and http(s) URLs understood by the client. &#x60;files&#x60; carries raw &#x60;.torrent&#x60; metainfo as standard base64 in &#x60;data&#x60;; the proxy validates the bencode, computes the info hash, and sends the original bytes to qBittorrent as multipart or to Transmission as &#x60;metainfo&#x60;. Files larger than 10 MiB are rejected with &#x60;413&#x60;, and the overall JSON body is limited to 16 MiB.  &#x60;hashes&#x60; contains the v1/v2 info hashes extracted from submitted &#x60;magnet:&#x60; URLs plus the info hashes of uploaded &#x60;.torrent&#x60; files; non-magnet URLs without an embedded hash contribute nothing. The client rejecting the torrent (for example because it already exists) returns &#x60;400&#x60; with an explanatory message.
     * Responses:
     *  - 200: The torrent client accepted the add request.
     *  - 400: No URLs or files were supplied, the base64 or bencode was invalid, or the torrent client rejected the torrent.
     *  - 401: Missing or invalid credentials.
     *  - 413: The request body or an uploaded `.torrent` file exceeds the limits. Individual `.torrent` files are limited to 10 MiB and the JSON body to 16 MiB.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @param addTorrentRequest
     * @return [AddTorrentResult]
     */
    @POST("api/torrents")
    suspend fun addTorrents(@Body addTorrentRequest: AddTorrentRequest): Response<AddTorrentResult>

    /**
     * GET api/torrents/{hash}
     * Read one torrent by info hash
     * Fetches a torrent without applying the relevance filter. Clients use this for duplicate checks, so an existing torrent anywhere in qBittorrent is reported even when Remagnet does not own it.
     * Responses:
     *  - 200: The torrent in the neutral shape.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 404: The torrent does not exist or does not match the proxy's filter.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @return [TorrentSummary]
     */
    @GET("api/torrents/{hash}")
    suspend fun getTorrent(@Path("hash") hash: kotlin.String): Response<TorrentSummary>

    /**
     * GET api/torrents
     * List the torrents owned by Remagnet
     * Lists qBittorrent torrents sorted by added time (newest first) and filters them server-side with the configured category and tags. A torrent matches when its category equals the configured category (case-insensitively) or any of its tags equals a configured tag. When both defaults are empty, every torrent matches.
     * Responses:
     *  - 200: The filtered torrent list.
     *  - 401: Missing or invalid credentials.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @return [TorrentList]
     */
    @GET("api/torrents")
    suspend fun listTorrents(): Response<TorrentList>

    /**
     * DELETE api/torrents/{hash}
     * Remove a torrent owned by Remagnet
     * Deletes a torrent only when it matches the proxy&#39;s configured category/tags filter. A torrent that does not exist, or that exists but is not owned by Remagnet, returns &#x60;404&#x60; so clients cannot remove unrelated torrents from a shared qBittorrent instance.
     * Responses:
     *  - 204: The torrent was deleted.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 404: The torrent does not exist or does not match the proxy's filter.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @param deleteFiles Also delete the downloaded files. (optional, default to false)
     * @return [Unit]
     */
    @DELETE("api/torrents/{hash}")
    suspend fun removeTorrent(@Path("hash") hash: kotlin.String, @Query("deleteFiles") deleteFiles: kotlin.Boolean? = false): Response<Unit>

}
