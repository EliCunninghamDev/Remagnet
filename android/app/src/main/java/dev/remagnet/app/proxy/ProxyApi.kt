package dev.remagnet.app.proxy

import dev.remagnet.proxy.apis.ArchivesApi
import dev.remagnet.proxy.apis.AuthApi
import dev.remagnet.proxy.apis.ConfigurationApi
import dev.remagnet.proxy.apis.DevicesApi
import dev.remagnet.proxy.apis.ServiceApi
import dev.remagnet.proxy.apis.TorrentsApi
import dev.remagnet.proxy.infrastructure.ApiClient
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Construction layer for the generated Remagnet proxy client.
 *
 * The Retrofit interfaces and models under `dev.remagnet.proxy` are generated
 * from `proxy/openapi.yaml`; this class only holds the app's configuration
 * choices. It uses the bearer-token interceptor, so the token never has to be
 * repeated on individual calls or written into logs as a query parameter.
 */
class ProxyApi(
    baseUrl: String,
    token: String,
) {
    val service: ServiceApi
    val configuration: ConfigurationApi
    val torrents: TorrentsApi
    val archives: ArchivesApi
    val auth: AuthApi
    val devices: DevicesApi

    init {
        val normalizedUrl = baseUrl.trim().trimEnd('/')
        val normalizedToken = token.trim()

        require(normalizedUrl.startsWith("http://") || normalizedUrl.startsWith("https://")) {
            "The Remagnet Proxy URL must use http:// or https://."
        }
        require(normalizedToken.isNotEmpty()) {
            "The Remagnet Proxy token is required."
        }

        val http = OkHttpClient.Builder()
            // A phone may leave the proxy URL pointed at a LAN address that is
            // no longer reachable. Fail in a time the UI can explain instead of
            // waiting out the platform default.
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

        val client = ApiClient(
            baseUrl = normalizedUrl,
            okHttpClientBuilder = http.newBuilder(),
            authNames = arrayOf(BEARER_AUTH),
        ).setBearerToken(normalizedToken)

        service = client.createService(ServiceApi::class.java)
        configuration = client.createService(ConfigurationApi::class.java)
        torrents = client.createService(TorrentsApi::class.java)
        archives = client.createService(ArchivesApi::class.java)
        auth = client.createService(AuthApi::class.java)
        devices = client.createService(DevicesApi::class.java)
    }

    private companion object {
        const val BEARER_AUTH = "bearerAuth"
    }
}
