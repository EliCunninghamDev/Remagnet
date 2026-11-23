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
     * Add one or more magnets
     * Adds &#x60;urls&#x60; to qBittorrent with the proxy&#39;s configured category and tags. Clients cannot override either value. A non-empty category is created first when missing, as are missing tags. With &#x60;paused: true&#x60; the proxy sends both qBittorrent 4.x (&#x60;paused&#x60;) and 5.x (&#x60;stopped&#x60;) form fields.  &#x60;hashes&#x60; contains the v1/v2 info hashes extracted from submitted &#x60;magnet:&#x60; URLs; non-magnet URLs simply contribute no hash. qBittorrent rejecting the torrent (for example because it already exists) returns &#x60;400&#x60; with an explanatory message.
     * Responses:
     *  - 200: qBittorrent accepted the add request.
     *  - 400: No URLs were supplied or qBittorrent rejected the torrent.
     *  - 401: Missing or invalid proxy token.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @param addTorrentRequest
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [AddTorrentResult]
     */
    @POST("api/torrents")
    suspend fun addTorrents(@Body addTorrentRequest: AddTorrentRequest, @Query("token") token: kotlin.String? = null): Response<AddTorrentResult>

    /**
     * GET api/torrents/{hash}
     * Read one torrent by info hash
     * Fetches a torrent without applying the relevance filter. Clients use this for duplicate checks, so an existing torrent anywhere in qBittorrent is reported even when Remagnet does not own it.
     * Responses:
     *  - 200: The torrent in the neutral shape.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid proxy token.
     *  - 404: The torrent does not exist or is not owned by Remagnet.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [TorrentSummary]
     */
    @GET("api/torrents/{hash}")
    suspend fun getTorrent(@Path("hash") hash: kotlin.String, @Query("token") token: kotlin.String? = null): Response<TorrentSummary>

    /**
     * GET api/torrents
     * List the torrents owned by Remagnet
     * Lists qBittorrent torrents sorted by added time (newest first) and filters them server-side with the configured category and tags. A torrent matches when its category equals the configured category (case-insensitively) or any of its tags equals a configured tag. When both defaults are empty, every torrent matches.
     * Responses:
     *  - 200: The filtered torrent list.
     *  - 401: Missing or invalid proxy token.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [TorrentList]
     */
    @GET("api/torrents")
    suspend fun listTorrents(@Query("token") token: kotlin.String? = null): Response<TorrentList>

    /**
     * DELETE api/torrents/{hash}
     * Remove a torrent owned by Remagnet
     * Deletes a torrent only when it matches the proxy&#39;s configured category/tags filter. A torrent that does not exist, or that exists but is not owned by Remagnet, returns &#x60;404&#x60; so clients cannot remove unrelated torrents from a shared qBittorrent instance.
     * Responses:
     *  - 204: The torrent was deleted.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid proxy token.
     *  - 404: The torrent does not exist or is not owned by Remagnet.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @param hash Torrent info hash. Accepts a 40-character BitTorrent v1 hash or a 64-character v2 hash, case-insensitively.
     * @param deleteFiles Also delete the downloaded files. (optional, default to false)
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [Unit]
     */
    @DELETE("api/torrents/{hash}")
    suspend fun removeTorrent(@Path("hash") hash: kotlin.String, @Query("deleteFiles") deleteFiles: kotlin.Boolean? = false, @Query("token") token: kotlin.String? = null): Response<Unit>

}
