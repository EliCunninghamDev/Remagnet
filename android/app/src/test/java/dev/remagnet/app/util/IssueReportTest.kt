package dev.remagnet.app.util

import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IssueReportTest {
    private val hash40 = "0123456789abcdef0123456789abcdef01234567"
    private val hash64 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    @Test
    fun replacesMagnets() {
        assertEquals(
            "Added [redacted-magnet]",
            redactSensitiveText(
                "Added magnet:?xt=urn:btih:$hash40&dn=Some.Release" +
                    "&tr=https%3A%2F%2Ftracker.example.com",
            ),
        )
    }

    @Test
    fun replacesUrlsIncludingQueryStringsThatCarryTokens() {
        assertEquals(
            "GET [redacted-url] failed",
            redactSensitiveText("GET https://proxy.example.com/api?token=rmg_abc123 failed"),
        )
        assertEquals(
            "see [redacted-url] for details",
            redactSensitiveText("see http://127.0.0.1:8080/api/torrents for details"),
        )
    }

    @Test
    fun replacesProxyTokensAndQbittorrentKeys() {
        assertEquals(
            "token [redacted-token] was rejected",
            redactSensitiveText("token rmg_abcDEF-123_xyz was rejected"),
        )
        assertEquals("[redacted-key] expired", redactSensitiveText("qbt_abcdef1234567890 expired"))
    }

    @Test
    fun replacesBearerHeadersRegardlessOfCase() {
        assertEquals(
            "Authorization: Bearer [redacted]",
            redactSensitiveText("Authorization: Bearer abc.def-123"),
        )
        assertEquals(
            "authorization: Bearer [redacted]",
            redactSensitiveText("authorization: bearer xyz"),
        )
    }

    @Test
    fun replacesFortyAndSixtyFourCharacterHashes() {
        assertEquals("hash [redacted-hash] done", redactSensitiveText("hash $hash40 done"))
        assertEquals("hash [redacted-hash] done", redactSensitiveText("hash $hash64 done"))
        assertEquals(
            "hash [redacted-hash] done",
            redactSensitiveText("hash ${hash40.uppercase()} done"),
        )
    }

    @Test
    fun replacesIpv4AddressesAndOptionalPorts() {
        assertEquals(
            "proxy at [redacted-ip] refused",
            redactSensitiveText("proxy at 192.168.1.20 refused"),
        )
        assertEquals(
            "proxy at [redacted-ip] refused",
            redactSensitiveText("proxy at 10.0.0.5:8080 refused"),
        )
    }

    @Test
    fun leavesOrdinaryTextUntouched() {
        val text = "The torrent list stayed empty after adding a torrent."
        assertEquals(text, redactSensitiveText(text))
    }

    @Test
    fun redactsSeveralKindsOfSensitiveDataInOneMessage() {
        val input = listOf(
            "Torrent magnet:?xt=urn:btih:$hash40",
            "at https://proxy.example.com/add?token=rmg_secret",
            "with key qbt_secret and hash $hash64",
            "from 172.16.0.9:8443",
            "using Authorization: Bearer abc123",
        ).joinToString(" ")

        assertEquals(
            listOf(
                "Torrent [redacted-magnet]",
                "at [redacted-url]",
                "with key [redacted-key] and hash [redacted-hash]",
                "from [redacted-ip]",
                "using Authorization: Bearer [redacted]",
            ).joinToString(" "),
            redactSensitiveText(input),
        )
    }

    @Test
    fun buildsTheMinimalDiagnosticsBlockAndLinks() {
        val report = buildIssueReport(version = "1.2.3")

        assertEquals("Android app", report.component)
        assertEquals("1.2.3", report.version)
        assertEquals("Component: Android app\nVersion: 1.2.3", report.diagnostics)

        assertTrue(report.githubUrl.startsWith("https://github.com/EliCunninghamDev/Remagnet/issues/new?"))
        val github = queryParams(report.githubUrl)
        assertEquals("bug_report.yml", github.getValue("template"))
        assertEquals("Android app", github.getValue("component"))
        assertEquals("1.2.3", github.getValue("version"))
        assertEquals(report.diagnostics, github.getValue("diagnostics"))

        assertTrue(report.mailtoUrl.startsWith("mailto:contact@elijahcunningham.dev?"))
        val mail = queryParams(report.mailtoUrl)
        assertEquals("Remagnet bug report (Android app 1.2.3)", mail.getValue("subject"))
        assertTrue(mail.getValue("body").startsWith("Please describe what happened"))
        assertTrue(mail.getValue("body").contains(report.diagnostics))
    }

    @Test
    fun includesAndRedactsTheOptionalContext() {
        val report = buildIssueReport(
            version = "0.2.0",
            androidRelease = "14",
            apiLevel = 34,
            deviceModel = "Pixel 7",
            context = IssueReportContext(
                action = "torrents:add",
                status = 502,
                code = "proxy_unreachable",
                backend = "https://admin:qbt_secret@qbt.example.com:8080",
                message = "Could not reach https://proxy.example.com using Bearer rmg_secret " +
                    "for $hash40 at 10.1.2.3",
            ),
        )

        assertEquals(
            listOf(
                "Component: Android app",
                "Version: 0.2.0",
                "Android: 14 (API 34)",
                "Device: Pixel 7",
                "Backend: [redacted-url]",
                "Action: torrents:add",
                "HTTP status: 502",
                "Error code: proxy_unreachable",
                "Error message: Could not reach [redacted-url] using Bearer [redacted] " +
                    "for [redacted-hash] at [redacted-ip]",
            ).joinToString("\n"),
            report.diagnostics,
        )

        assertEquals(report.diagnostics, queryParams(report.githubUrl).getValue("diagnostics"))
        assertEquals(
            "Remagnet bug report (Android app 0.2.0)",
            queryParams(report.mailtoUrl).getValue("subject"),
        )
    }

    @Test
    fun describesAndroidVersionApiAndDeviceSeparately() {
        assertEquals(
            "Component: Android app\nVersion: 1.0.0\nAndroid API level: 34",
            buildIssueReport(version = "1.0.0", apiLevel = 34).diagnostics,
        )
        assertEquals(
            "Component: Android app\nVersion: 1.0.0\nAndroid: 14",
            buildIssueReport(version = "1.0.0", androidRelease = "14").diagnostics,
        )
    }

    @Test
    fun omitsBlankOptionalValues() {
        val report = buildIssueReport(
            version = "1.0.0",
            androidRelease = "   ",
            deviceModel = "  ",
            context = IssueReportContext(
                action = " ",
                message = " ",
                code = " ",
                backend = " ",
            ),
        )

        assertEquals("Component: Android app\nVersion: 1.0.0", report.diagnostics)
    }

    @Test
    fun encodesSpacesAsPercentTwentyInTheMailtoUrl() {
        val report = buildIssueReport(version = "1.0.0")

        assertFalse(report.mailtoUrl.contains("+"))
        assertTrue(report.mailtoUrl.contains("%20"))
        assertTrue(queryParams(report.mailtoUrl).getValue("subject").contains("Android app"))
    }

    @Test
    fun keepsTheGithubUrlUnderTwoThousandCharacters() {
        val report = buildIssueReport(
            version = "1.0.0",
            context = IssueReportContext(message = "x".repeat(5000)),
        )

        assertTrue("length=${report.githubUrl.length}", report.githubUrl.length < 2000)
        assertFalse(report.githubUrl.contains("+"))
        assertTrue(queryParams(report.githubUrl).getValue("diagnostics").endsWith("(truncated)"))
        // The payload keeps the full redacted block for copy/paste and mail.
        assertTrue(report.diagnostics.length > 5000)
        assertTrue(report.diagnostics.contains("x".repeat(5000)))
        assertTrue(queryParams(report.mailtoUrl).getValue("body").contains("x".repeat(5000)))
    }

    private fun queryParams(uri: String): Map<String, String> =
        uri.substringAfter('?', missingDelimiterValue = "")
            .split('&')
            .filter { it.isNotEmpty() }
            .associate { part ->
                val name = part.substringBefore('=')
                val value = part.substringAfter('=', missingDelimiterValue = "")
                URLDecoder.decode(name, "UTF-8") to URLDecoder.decode(value, "UTF-8")
            }
}
