package dev.remagnet.app.util

import java.net.URLEncoder

/**
 * Opt-in bug report text, built locally before the user chooses to send it.
 *
 * Nothing here uploads anything: the settings screen opens a GitHub issue or a
 * mail draft, and the redaction below keeps magnets, URLs, proxy tokens,
 * qBittorrent keys, hashes and addresses out of whatever the user decides to
 * share.
 */
data class IssueReportContext(
    val action: String? = null,
    val message: String? = null,
    val code: String? = null,
    val status: Int? = null,
    val backend: String? = null,
)

data class IssueReportPayload(
    val component: String,
    val version: String,
    val diagnostics: String,
    val githubUrl: String,
    val mailtoUrl: String,
)

private const val COMPONENT = "Android app"
private const val GITHUB_ISSUES_URL = "https://github.com/EliCunninghamDev/Remagnet/issues/new"
private const val CONTACT_EMAIL = "contact@elijahcunningham.dev"

/** GitHub rejects issue URLs longer than this, so the diagnostics param is trimmed. */
private const val GITHUB_URL_LIMIT = 2000
private const val TRUNCATION_NOTE = "\n… (truncated)"
private const val MAILTO_PROMPT = "Please describe what happened and what you expected:\n\n"

private val REDACTIONS: List<Pair<Regex, String>> = listOf(
    Regex("""magnet:\?[^\s"'<>]+""", RegexOption.IGNORE_CASE) to "[redacted-magnet]",
    Regex("""https?://[^\s"'<>]+""", RegexOption.IGNORE_CASE) to "[redacted-url]",
    Regex("""rmg_[A-Za-z0-9_-]+""") to "[redacted-token]",
    Regex("""qbt_[A-Za-z0-9_-]+""") to "[redacted-key]",
    Regex("""Bearer\s+\S+""", RegexOption.IGNORE_CASE) to "Bearer [redacted]",
    Regex("""\b[0-9a-fA-F]{64}\b""") to "[redacted-hash]",
    Regex("""\b[0-9a-fA-F]{40}\b""") to "[redacted-hash]",
    Regex("""\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b""") to "[redacted-ip]",
)

/**
 * Replace secrets and identifying details with stable placeholders.
 *
 * The placeholders are deliberately readable: a maintainer can still see that
 * a token, hash or address was involved without receiving its value.
 */
fun redactSensitiveText(input: String): String {
    var output = input
    for ((pattern, replacement) in REDACTIONS) {
        output = output.replace(pattern, replacement)
    }
    return output
}

/**
 * Build a plain-text report plus ready-to-open GitHub and mail links.
 *
 * The full (redacted) diagnostics stay in [IssueReportPayload.diagnostics];
 * only the copy embedded in [IssueReportPayload.githubUrl] is shortened when
 * the URL would overflow GitHub's limit.
 */
fun buildIssueReport(
    version: String,
    androidRelease: String? = null,
    apiLevel: Int? = null,
    deviceModel: String? = null,
    context: IssueReportContext? = null,
): IssueReportPayload {
    val cleanVersion = version.trim()
    val diagnostics =
        formatDiagnostics(cleanVersion, androidRelease, apiLevel, deviceModel, context)

    return IssueReportPayload(
        component = COMPONENT,
        version = cleanVersion,
        diagnostics = diagnostics,
        githubUrl = buildGithubUrl(cleanVersion, diagnostics),
        mailtoUrl = buildMailtoUrl(cleanVersion, diagnostics),
    )
}

private fun formatDiagnostics(
    version: String,
    androidRelease: String?,
    apiLevel: Int?,
    deviceModel: String?,
    context: IssueReportContext?,
): String {
    val lines = mutableListOf(
        "Component: $COMPONENT",
        "Version: $version",
    )

    val release = androidRelease?.trim()?.takeIf { it.isNotEmpty() }
    when {
        release != null && apiLevel != null -> lines += "Android: $release (API $apiLevel)"
        release != null -> lines += "Android: $release"
        apiLevel != null -> lines += "Android API level: $apiLevel"
    }

    deviceModel?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "Device: $it" }

    context?.backend?.trim()?.takeIf { it.isNotEmpty() }?.let {
        lines += "Backend: ${redactSensitiveText(it)}"
    }

    context?.action?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "Action: $it" }

    context?.status?.let { lines += "HTTP status: $it" }

    context?.code?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "Error code: $it" }

    context?.message?.trim()?.takeIf { it.isNotEmpty() }?.let {
        lines += "Error message: ${redactSensitiveText(it)}"
    }

    return lines.joinToString("\n")
}

private fun buildGithubUrl(version: String, diagnostics: String): String {
    val fitted = fitDiagnosticsForUrl(version, diagnostics)
    val query = listOf(
        "template" to "bug_report.yml",
        "component" to COMPONENT,
        "version" to version,
        "diagnostics" to fitted,
    ).joinToString("&") { (name, value) -> "${encode(name)}=${encode(value)}" }

    return "$GITHUB_ISSUES_URL?$query"
}

private fun githubUrlLength(version: String, diagnostics: String): Int {
    val query = listOf(
        "template" to "bug_report.yml",
        "component" to COMPONENT,
        "version" to version,
        "diagnostics" to diagnostics,
    ).joinToString("&") { (name, value) -> "${encode(name)}=${encode(value)}" }

    return GITHUB_ISSUES_URL.length + 1 + query.length
}

/** Longest prefix of [diagnostics] whose encoded URL still fits GitHub's limit. */
private fun fitDiagnosticsForUrl(version: String, diagnostics: String): String {
    if (githubUrlLength(version, diagnostics) < GITHUB_URL_LIMIT) return diagnostics

    var low = 0
    var high = diagnostics.length
    while (low < high) {
        val mid = (low + high + 1) / 2
        if (githubUrlLength(version, truncate(diagnostics, mid)) < GITHUB_URL_LIMIT) {
            low = mid
        } else {
            high = mid - 1
        }
    }
    return truncate(diagnostics, low)
}

private fun truncate(value: String, length: Int): String =
    value.take(length).trimEnd() + TRUNCATION_NOTE

private fun buildMailtoUrl(version: String, diagnostics: String): String {
    val subject = "Remagnet bug report ($COMPONENT $version)"
    val body = "$MAILTO_PROMPT$diagnostics"
    return "mailto:$CONTACT_EMAIL?subject=${encode(subject)}&body=${encode(body)}"
}

/**
 * Percent-encode a query value, using `%20` rather than `+` so Android mail
 * apps render spaces in the pre-filled draft exactly as written.
 */
private fun encode(value: String): String =
    URLEncoder.encode(value, "UTF-8").replace("+", "%20")
