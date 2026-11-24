package dev.remagnet.app.client

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkErrorsTest {
    private val baseUrl = "https://remagnet.example.com"

    @Test
    fun aCertificateFailureNamesTls() {
        val message = describeProxyConnectionFailure(
            SSLHandshakeException("Trust anchor for certification path not found."),
            baseUrl,
        )

        assertTrue(message, message.contains("TLS certificate"))
        assertTrue(message, message.contains("remagnet.example.com"))
    }

    @Test
    fun aWrappedCertificateFailureIsStillTls() {
        val error = SSLHandshakeException("handshake failed").apply {
            initCause(CertificateException("untrusted"))
        }

        val message = describeProxyConnectionFailure(error, baseUrl)

        assertTrue(message, message.contains("TLS certificate"))
    }

    @Test
    fun aDnsFailureSaysItCouldNotResolve() {
        val message = describeProxyConnectionFailure(
            UnknownHostException("remagnet.example.com"),
            baseUrl,
        )

        assertTrue(message, message.contains("Could not resolve"))
        assertTrue(message, message.contains("remagnet.example.com"))
    }

    @Test
    fun aRefusedConnectionIsNotReportedAsADnsFailure() {
        val message = describeProxyConnectionFailure(
            ConnectException("Connection refused"),
            baseUrl,
        )

        assertTrue(message, message.contains("Could not connect"))
    }

    @Test
    fun aTimeoutIsReportedAsATimeout() {
        val message = describeProxyConnectionFailure(
            SocketTimeoutException("timeout"),
            baseUrl,
        )

        assertTrue(message, message.contains("Timed out"))
    }

    @Test
    fun anUnknownIoFailureKeepsTheGeneralMessage() {
        val message = describeProxyConnectionFailure(
            IOException("broken pipe"),
            baseUrl,
        )

        assertTrue(message, message.contains("Could not reach"))
    }
}
