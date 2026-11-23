package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.ConfigUpdate
import dev.remagnet.proxy.models.ConnectionHealth
import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.PublicConfig
import dev.remagnet.proxy.models.ServiceUnavailable

interface ConfigurationApi {
    /**
     * GET api/health
     * Read proxy capabilities and qBittorrent versions
     * Calls qBittorrent&#39;s &#x60;app/version&#x60; and &#x60;app/webapiVersion&#x60; endpoints with the saved credentials and reports the neutral capabilities and current magnet defaults. Used by the extension&#39;s connection test, the Android app and the configuration page.
     * Responses:
     *  - 200: qBittorrent answered with its versions.
     *  - 401: Missing or invalid credentials.
     *  - 502: qBittorrent could not be reached or returned an error.
     *  - 503: qBittorrent credentials have not been configured on the proxy yet.
     *
     * @return [ConnectionHealth]
     */
    @GET("api/health")
    suspend fun checkQbitConnection(): Response<ConnectionHealth>

    /**
     * GET api/config
     * Read non-secret configuration
     * Returns the qBittorrent base URL and username, flags indicating whether an API key and password are saved, and the category/tags applied to magnets. Secret values are never returned, and this endpoint does not contact qBittorrent.
     * Responses:
     *  - 200: Current public configuration.
     *  - 401: Missing or invalid credentials.
     *
     * @return [PublicConfig]
     */
    @GET("api/config")
    suspend fun getConfig(): Response<PublicConfig>

    /**
     * PUT api/config
     * Update the qBittorrent connection and magnet defaults
     * Replaces the saved qBittorrent settings and returns the new public configuration. &#x60;qbitBaseUrl&#x60; is required and is normalized by trimming whitespace and trailing slashes; credentials in the URL, query strings and fragments are rejected.  For the secret fields (&#x60;qbitApiKey&#x60;, &#x60;qbitUsername&#x60;, &#x60;qbitPassword&#x60;), omitting a field keeps the saved value and sending an empty string clears it. Credentials are not required when saving: the proxy remains bootable and qBittorrent-backed endpoints return &#x60;503&#x60; until an API key or username is saved. Saving valid credentials activates the client without a restart.  &#x60;defaultCategory&#x60; and &#x60;defaultTags&#x60; are the values applied to every magnet added through the proxy. Omitting either field keeps the saved value. Tags are trimmed and deduplicated; an empty array clears the tag filter. When both the category and tags are empty, every torrent in qBittorrent is exposed.
     * Responses:
     *  - 200: Configuration saved; the returned values are the effective ones.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 500: The proxy could not save configuration or start the archive.
     *
     * @param configUpdate
     * @return [PublicConfig]
     */
    @PUT("api/config")
    suspend fun updateConfig(@Body configUpdate: ConfigUpdate): Response<PublicConfig>

}
