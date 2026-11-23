package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.DeviceList
import dev.remagnet.proxy.models.Error

interface DevicesApi {
    /**
     * GET api/devices
     * List registered devices
     * Returns every device token record. The raw token is never returned; only its id, name and timestamps are available. Requires an administrator session.
     * Responses:
     *  - 200: Registered devices, oldest first.
     *  - 401: Missing or invalid credentials.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *
     * @return [DeviceList]
     */
    @GET("api/devices")
    suspend fun listDevices(): Response<DeviceList>

    /**
     * DELETE api/devices/{id}
     * Revoke a device token
     * Deletes the device record, which immediately invalidates its token. Requires an administrator session. An unknown id returns &#x60;404&#x60;.
     * Responses:
     *  - 204: The device token was revoked.
     *  - 401: Missing or invalid credentials.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *  - 404: No device has that id.
     *
     * @param id Device id returned by &#x60;GET /api/devices&#x60;.
     * @return [Unit]
     */
    @DELETE("api/devices/{id}")
    suspend fun revokeDevice(@Path("id") id: kotlin.String): Response<Unit>

}
