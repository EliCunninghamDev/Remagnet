package dev.remagnet.proxy.apis

import dev.remagnet.proxy.infrastructure.CollectionFormats.*
import retrofit2.http.*
import retrofit2.Response
import okhttp3.RequestBody
import com.google.gson.annotations.SerializedName

import dev.remagnet.proxy.models.AuthSession
import dev.remagnet.proxy.models.AuthStatus
import dev.remagnet.proxy.models.ChangePasswordRequest
import dev.remagnet.proxy.models.DeviceLoginRequest
import dev.remagnet.proxy.models.DeviceLoginResponse
import dev.remagnet.proxy.models.DisableTotpRequest
import dev.remagnet.proxy.models.Error
import dev.remagnet.proxy.models.LoginRequest
import dev.remagnet.proxy.models.SetupAdminRequest
import dev.remagnet.proxy.models.TotpCodeRequest
import dev.remagnet.proxy.models.TotpEnabled
import dev.remagnet.proxy.models.TotpSetup

interface AuthApi {
    /**
     * POST api/auth/password
     * Change the administrator password
     * Requires the current password and a new password of at least 12 characters. Every existing session, including the caller&#39;s, is revoked; the response sets a fresh session cookie for the current browser.
     * Responses:
     *  - 204: The password was changed and a fresh session cookie was set.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 403: The current password is incorrect.
     *
     * @param changePasswordRequest
     * @return [Unit]
     */
    @POST("api/auth/password")
    suspend fun changePassword(@Body changePasswordRequest: ChangePasswordRequest): Response<Unit>

    /**
     * POST api/auth/2fa/disable
     * Disable two-factor authentication
     * Requires the administrator password and, when two-factor authentication is enabled, a valid TOTP or recovery code. Clears the secret, the replay marker and every remaining recovery code.
     * Responses:
     *  - 204: Two-factor authentication is disabled.
     *  - 400: Two-factor authentication is enabled and no code was sent.
     *  - 401: Missing or invalid credentials.
     *  - 403: The password is incorrect.
     *
     * @param disableTotpRequest
     * @return [Unit]
     */
    @POST("api/auth/2fa/disable")
    suspend fun disableTotp(@Body disableTotpRequest: DisableTotpRequest): Response<Unit>

    /**
     * POST api/auth/2fa/enable
     * Confirm two-factor enrolment
     * Verifies a code against the pending secret, stores the secret on the administrator account and returns eight single-use recovery codes. The codes are shown only in this response. The current TOTP step is consumed, so the same code cannot immediately be used to sign in.
     * Responses:
     *  - 200: Two-factor authentication is enabled.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 401: Missing or invalid credentials.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *
     * @param totpCodeRequest
     * @return [TotpEnabled]
     */
    @POST("api/auth/2fa/enable")
    suspend fun enableTotp(@Body totpCodeRequest: TotpCodeRequest): Response<TotpEnabled>

    /**
     * GET api/auth/status
     * Read setup and sign-in state
     * Public bootstrap probe used by the proxy page, the extension and the Android app. Reports whether an administrator account exists, whether the deployment requires a setup code, whether the request already carries a valid session, and whether two-factor authentication is enabled.
     * Responses:
     *  - 200: Current authentication state.
     *
     * @return [AuthStatus]
     */
    @GET("api/auth/status")
    suspend fun getAuthStatus(): Response<AuthStatus>

    /**
     * POST api/auth/login
     * Sign in to the administrator account
     * Verifies the username and password, then the second factor when enabled. When two-factor authentication is enabled and &#x60;totpCode&#x60; is missing or empty, the response is &#x60;401&#x60; with &#x60;code: \&quot;totp_required\&quot;&#x60; so the client can ask for a code. A supplied code may be a TOTP code or an unused recovery code; recovery codes are consumed once. Repeated failures from one address are throttled with &#x60;429&#x60;. On success a session cookie is set.
     * Responses:
     *  - 200: Signed in; the session cookie identifies the browser.
     *  - 401: Bad credentials, a rejected two-factor code, or a missing code when two-factor authentication is enabled (`code: \"totp_required\"`).
     *  - 429: Too many sign-in attempts from this address. `Retry-After` is the number of seconds to wait before trying again, and `code` is `rate_limited`.
     *
     * @param loginRequest
     * @return [AuthSession]
     */
    @POST("api/auth/login")
    suspend fun loginAdmin(@Body loginRequest: LoginRequest): Response<AuthSession>

    /**
     * POST api/auth/device
     * Exchange credentials for a per-device token
     * Public alternative to pairing for clients that can prompt for the administrator username and password. Mints a &#x60;rmg_…&#x60; token scoped to the client API and returns it once with the new device record. When two-factor authentication is enabled, &#x60;totpCode&#x60; is required and a missing code returns &#x60;401&#x60; with &#x60;code: \&quot;totp_required\&quot;&#x60;. Failed attempts are throttled with &#x60;429&#x60;.  The token can never reach administrative endpoints.
     * Responses:
     *  - 200: A new device token and its public device record.
     *  - 401: Bad credentials, a rejected two-factor code, or a missing code when two-factor authentication is enabled (`code: \"totp_required\"`).
     *  - 429: Too many sign-in attempts from this address. `Retry-After` is the number of seconds to wait before trying again, and `code` is `rate_limited`.
     *
     * @param deviceLoginRequest
     * @return [DeviceLoginResponse]
     */
    @POST("api/auth/device")
    suspend fun loginDevice(@Body deviceLoginRequest: DeviceLoginRequest): Response<DeviceLoginResponse>

    /**
     * POST api/auth/logout
     * Sign out the current administrator session
     * Revokes the session cookie and clears it in the response. Requires an administrator session; a device token is not enough.
     * Responses:
     *  - 204: The session was revoked and the cookie cleared.
     *  - 401: Missing or invalid credentials.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *
     * @return [Unit]
     */
    @POST("api/auth/logout")
    suspend fun logoutAdmin(): Response<Unit>

    /**
     * POST api/auth/setup
     * Create the administrator account
     * First-run enrolment. Fails with &#x60;409&#x60; once an administrator exists. When the deployment sets a setup code, &#x60;setupCode&#x60; must match it or the request returns &#x60;403&#x60;. The username is trimmed and must contain 1 to 64 characters; the password must contain at least 12 characters. On success the account is saved, a session cookie is set and the response body is the same &#x60;AuthSession&#x60; returned by sign-in.
     * Responses:
     *  - 201: The administrator account was created and signed in.
     *  - 400: The request was rejected, for example an invalid URL, hash or field.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *  - 409: The proxy is already set up.
     *
     * @param setupAdminRequest
     * @return [AuthSession]
     */
    @POST("api/auth/setup")
    suspend fun setupAdmin(@Body setupAdminRequest: SetupAdminRequest): Response<AuthSession>

    /**
     * POST api/auth/2fa/setup
     * Begin two-factor enrolment
     * Generates a new TOTP secret, stores it as pending and returns the secret, its &#x60;otpauth://&#x60; URI and an inline SVG QR code. The secret does not take effect until &#x60;POST /api/auth/2fa/enable&#x60; verifies a code.
     * Responses:
     *  - 200: A pending secret and its QR code.
     *  - 401: Missing or invalid credentials.
     *  - 403: Authenticated, but not allowed to perform this action. Administrative routes return this for a valid device token; setup returns it for a wrong setup code.
     *
     * @return [TotpSetup]
     */
    @POST("api/auth/2fa/setup")
    suspend fun setupTotp(): Response<TotpSetup>

}
