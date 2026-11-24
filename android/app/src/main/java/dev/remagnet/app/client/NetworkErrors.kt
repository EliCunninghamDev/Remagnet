package dev.remagnet.app.client

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/**
 * Say which network layer failed instead of reporting every [java.io.IOException]
 * as "could not reach".
 *
 * OkHttp reports DNS failures, refused connections, timeouts and TLS failures as
 * different IOException subclasses. Collapsing them hid the case that matters
 * most to self-hosted clients: a router or captive portal answering on the same
 * hostname with a certificate the phone does not trust.
 */
fun describeProxyConnectionFailure(error: Throwable, baseUrl: String): String {
    val causes = generateSequence(error) { it.cause }.toList()
    val host = runCatching { URI(baseUrl).host }.getOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: baseUrl

    return when {
        causes.any { it is SSLException || it is CertificateException } ->
            "The TLS certificate for $host is not trusted. Check that this URL reaches " +
                "the Remagnet Proxy and not a router or captive portal."

        causes.any { it is UnknownHostException } ->
            "Could not resolve $host. Check the phone's DNS or the Remagnet Proxy URL."

        causes.any { it is SocketTimeoutException } ->
            "Timed out reaching the Remagnet Proxy at $baseUrl. Check the network."

        causes.any { it is ConnectException } ->
            "Could not connect to the Remagnet Proxy at $baseUrl. Check that the port " +
                "is open and the proxy is running."

        else ->
            "Could not reach the Remagnet Proxy at $baseUrl. Check the URL and network."
    }
}
