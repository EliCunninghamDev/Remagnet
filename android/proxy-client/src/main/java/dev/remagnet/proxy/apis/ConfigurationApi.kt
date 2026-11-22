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

interface ConfigurationApi {
    /**
     * GET api/health
     * Test the saved qBittorrent connection
     * Calls qBittorrent&#39;s &#x60;app/version&#x60; and &#x60;app/webapiVersion&#x60; endpoints with the saved credentials. Used by the extension&#39;s \&quot;Save &amp; test archive\&quot; action and the configuration page. 
     * Responses:
     *  - 200: qBittorrent answered with its versions.
     *  - 401: Missing or invalid proxy token.
     *  - 502: qBittorrent could not be reached or returned an error.
     *
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [ConnectionHealth]
     */
    @GET("api/health")
    suspend fun checkQbitConnection(@Query("token") token: kotlin.String? = null): Response<ConnectionHealth>

    /**
     * GET api/config
     * Read non-secret configuration
     * Returns the qBittorrent base URL and username plus flags indicating whether an API key and password are saved. Secret values are never returned, and this endpoint does not contact qBittorrent. 
     * Responses:
     *  - 200: Current public configuration.
     *  - 401: Missing or invalid proxy token.
     *
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [PublicConfig]
     */
    @GET("api/config")
    suspend fun getConfig(@Query("token") token: kotlin.String? = null): Response<PublicConfig>

    /**
     * PUT api/config
     * Update the qBittorrent connection
     * Replaces the saved qBittorrent settings and returns the new public configuration. &#x60;qbitBaseUrl&#x60; is required and is normalized by trimming whitespace and trailing slashes; credentials in the URL, query strings and fragments are rejected.  For the secret fields (&#x60;qbitApiKey&#x60;, &#x60;qbitUsername&#x60;, &#x60;qbitPassword&#x60;), omitting a field keeps the saved value and sending an empty string clears it. At least one of &#x60;qbitApiKey&#x60; or &#x60;qbitUsername&#x60; must remain set. A request that fails validation leaves the stored configuration untouched. 
     * Responses:
     *  - 200: Configuration saved; the returned values are the effective ones.
     *  - 400: The request was rejected, for example an invalid URL or no usable credentials.
     *  - 401: Missing or invalid proxy token.
     *  - 500: The proxy could not save configuration or start the archive.
     *
     * @param configUpdate 
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [PublicConfig]
     */
    @PUT("api/config")
    suspend fun updateConfig(@Body configUpdate: ConfigUpdate, @Query("token") token: kotlin.String? = null): Response<PublicConfig>

}
