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
     * Calls qBittorrent&#39;s &#x60;app/version&#x60; and &#x60;app/webapiVersion&#x60; endpoints with the saved credentials and reports the neutral capabilities and current magnet defaults. Used by the extension&#39;s connection test, the Android app and the configuration page. &#x60;apiVersion&#x60; is the client contract version; &#x60;proxyVersion&#x60; is this proxy crate&#39;s version.
     * Responses:
     *  - 200: qBittorrent answered with its versions.
     *  - 401: Missing or invalid credentials.
     *  - 502: The configured torrent client could not be reached or returned an error. `code` distinguishes `upstream_unreachable`, `upstream_auth` and `upstream_error`.
     *  - 503: No torrent client has been configured on the proxy yet. The body carries `code: not_configured` so clients can distinguish this from other server failures.
     *
     * @return [ConnectionHealth]
     */
    @GET("api/health")
    suspend fun checkQbitConnection(): Response<ConnectionHealth>

    /**
     * GET api/config
     * Read non-secret configuration
     * Returns the selected torrent client, its base URL and username, flags indicating whether an API key and password are saved, the optional read-only downloads mount and the category/tags applied to magnets. Secret values are never returned, and this endpoint does not contact the torrent client.  Values supplied through environment variables (&#x60;CLIENT_KIND&#x60;, &#x60;CLIENT_BASE_URL&#x60;/&#x60;QBIT_BASE_URL&#x60;/&#x60;TRANSMISSION_BASE_URL&#x60;, &#x60;QBIT_API_KEY&#x60;, &#x60;CLIENT_USERNAME&#x60;/&#x60;QBIT_USERNAME&#x60;, &#x60;CLIENT_PASSWORD&#x60;/&#x60;QBIT_PASSWORD&#x60;, &#x60;DOWNLOADS_DIR&#x60;, &#x60;CLIENT_DOWNLOADS_DIR&#x60;, &#x60;REMAGNET_CATEGORY&#x60;, and &#x60;REMAGNET_TAGS&#x60;) override &#x60;config.json&#x60; and are listed in &#x60;envLocked&#x60;. Leave those fields disabled in the UI: a subsequent &#x60;PUT /api/config&#x60; keeps the environment value even if it sends a different one.
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
     * Update the torrent client connection and magnet defaults
     * Replaces the saved torrent client settings and returns the new public configuration. &#x60;baseUrl&#x60; is required unless the proxy is already configured or &#x60;baseUrl&#x60; is locked by an environment variable; omitting it keeps the current URL. It is normalized by trimming whitespace and trailing slashes; credentials in the URL, query strings and fragments are rejected. &#x60;qbitBaseUrl&#x60; is accepted as an alias.  Fields listed in &#x60;envLocked&#x60; are read-only: a value sent for one is ignored and the environment value stays in effect. Environment-provided API keys and passwords are never written to &#x60;config.json&#x60;.  For the secret fields (&#x60;apiKey&#x60;, &#x60;username&#x60;, &#x60;password&#x60;, plus the &#x60;qbit*&#x60; aliases), omitting a field keeps the saved value and sending an empty string clears it. Credentials are not required when saving: the proxy remains bootable and client-backed endpoints return &#x60;503&#x60; until setup is complete. Transmission only needs a URL; a private network can leave its optional username and password blank. Saving valid settings activates the client without a restart.  &#x60;downloadsDir&#x60; enables ZIP archive downloads and should point at the client&#39;s downloads volume mounted read-only. &#x60;clientDownloadsDir&#x60; is an optional prefix mapping, such as &#x60;/data/torrents&#x60;, for torrent paths as the client reports them.  &#x60;defaultCategory&#x60; and &#x60;defaultTags&#x60; are the values applied to every magnet added through the proxy. Omitting either field keeps the saved value. Tags are trimmed and deduplicated; an empty array clears the tag filter. When both the category and tags are empty, every torrent is exposed.
     * Responses:
     *  - 200: Configuration saved; the returned values are the effective ones.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 500: The proxy hit an unexpected internal error. The body uses `code: internal_error` and a generic message; technical detail is only written to the proxy logs.
     *
     * @param configUpdate
     * @return [PublicConfig]
     */
    @PUT("api/config")
    suspend fun updateConfig(@Body configUpdate: ConfigUpdate): Response<PublicConfig>

}
