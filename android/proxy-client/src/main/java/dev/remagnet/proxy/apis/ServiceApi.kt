package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.Liveness

interface ServiceApi {
    /**
     * GET
     * Configuration page
     * Static HTML page for setting the qBittorrent Web UI URL and credentials, plus the category and tags applied to new magnets. The page never receives saved secrets back. Served with &#x60;Cache-Control: no-store&#x60; and &#x60;X-Content-Type-Options: nosniff&#x60;.
     * Responses:
     *  - 200: HTML configuration page.
     *
     * @return [kotlin.String]
     */
    @GET("")
    suspend fun getConfigPage(): Response<kotlin.String>

    /**
     * GET healthz
     * Liveness probe
     * Reports that the process is running. Does not contact qBittorrent.
     * Responses:
     *  - 200: The service is alive.
     *
     * @return [Liveness]
     */
    @GET("healthz")
    suspend fun getLiveness(): Response<Liveness>

}
