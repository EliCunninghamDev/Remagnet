package dev.remagnet.app.proxy

import dev.remagnet.proxy.apis.ArchivesApi
import dev.remagnet.proxy.apis.ConfigurationApi
import dev.remagnet.proxy.infrastructure.ApiClient
import okhttp3.OkHttpClient

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
    val configuration: ConfigurationApi
    val archives: ArchivesApi

    init {
        val normalizedUrl = baseUrl.trim().trimEnd('/')
        val normalizedToken = token.trim()

        require(normalizedUrl.startsWith("http://") || normalizedUrl.startsWith("https://")) {
            "The archive bridge URL must use http:// or https://."
        }
        require(normalizedToken.isNotEmpty()) {
            "The archive bridge token is required."
        }

        val client = ApiClient(
            baseUrl = normalizedUrl,
            okHttpClientBuilder = OkHttpClient.Builder(),
            authNames = arrayOf(BEARER_AUTH),
        ).setBearerToken(normalizedToken)

        configuration = client.createService(ConfigurationApi::class.java)
        archives = client.createService(ArchivesApi::class.java)
    }

    private companion object {
        const val BEARER_AUTH = "bearerAuth"
    }
}
