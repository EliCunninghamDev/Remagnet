package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.CreatePairingRequest
import dev.remagnet.proxy.models.EncryptedPayload
import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.PairingClaim
import dev.remagnet.proxy.models.PairingSession

interface PairingApi {
    /**
     * POST api/pair/claim
     * Claim a pairing code and receive encrypted connection settings
     * The Android app, or the extension&#39;s pairing field, sends the session id and &#x60;SHA-256(code)&#x60;, not the code itself. On success the proxy consumes the session and returns the qBittorrent URL, credentials, and proxy token encrypted with AES-256-GCM. Both sides derive the key from the scanned code and the session id, so a logged request or response is useless without the code.  The plaintext is a JSON object described by &#x60;PairingPayload&#x60;. Invalid, expired, or already-claimed codes return &#x60;400&#x60; and no payload.
     * Responses:
     *  - 200: Encrypted connection settings for the scanning device.
     *  - 400: The pairing code is invalid, expired, or already used.
     *
     * @param pairingClaim
     * @return [EncryptedPayload]
     */
    @POST("api/pair/claim")
    suspend fun claimPairing(@Body pairingClaim: PairingClaim): Response<EncryptedPayload>

    /**
     * POST api/pair
     * Mint a short-lived device pairing code
     * Creates an in-memory pairing session and returns the &#x60;remagnet://pair&#x60; link plus a ready-to-display SVG QR code. The Remagnet Proxy page shows the QR for the Android app and copies the link for the extension, which claims it from Settings. The code is single-use and is never stored on disk; restarting the proxy invalidates outstanding sessions.  Minting requires the proxy token. Claiming the code does not, because the device or extension claiming it has not been configured yet. Pairing carries credentials, so the origin must use HTTPS unless it is loopback or the Android emulator host (&#x60;10.0.2.2&#x60;).
     * Responses:
     *  - 200: A pairing session and its rendered QR code.
     *  - 400: The supplied origin is invalid, unreachable without HTTPS, or missing.
     *  - 401: Missing or invalid proxy token.
     *
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @param createPairingRequest The origin to encode in the link. The proxy page sends &#x60;location.origin&#x60;, which is the address the phone must be able to reach. When omitted, the proxy falls back to the &#x60;Host&#x60; and &#x60;X-Forwarded-Proto&#x60; headers.  (optional)
     * @return [PairingSession]
     */
    @POST("api/pair")
    suspend fun createPairing(@Query("token") token: kotlin.String? = null, @Body createPairingRequest: CreatePairingRequest? = null): Response<PairingSession>

    /**
     * DELETE api/pair/{id}
     * Revoke an outstanding pairing code
     * Called when the proxy page hides or rotates the QR code. Revoking an unknown or expired id is not an error, so a retry is safe.
     * Responses:
     *  - 204: The session is gone.
     *  - 401: Missing or invalid proxy token.
     *
     * @param id
     * @param token Proxy token as a query parameter. Alternative to &#x60;Authorization: Bearer &lt;token&gt;&#x60;; either one is sufficient.  (optional)
     * @return [Unit]
     */
    @DELETE("api/pair/{id}")
    suspend fun revokePairing(@Path("id") id: kotlin.String, @Query("token") token: kotlin.String? = null): Response<Unit>

}
