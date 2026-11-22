package dev.remagnet.app.download

import android.content.Context
import android.os.Environment
import java.io.File
import java.net.URLDecoder

private val ILLEGAL_FILE_CHARACTERS = Regex("""[/\\:*?"<>|\u0000-\u001f]""")
private val WHITESPACE = Regex("\\s+")
private const val MAX_NAME_CODE_POINTS = 100

/**
 * Turn a torrent or Content-Disposition name into a safe `.zip` file name.
 *
 * The proxy already sanitizes entry names, but its suggested file name and a
 * torrent name still come from outside the app. Directories are stripped so a
 * crafted name cannot escape the downloads folder.
 */
fun safeArchiveName(raw: String): String {
    var name = raw.trim().substringAfterLast('/').substringAfterLast('\\')
    name = ILLEGAL_FILE_CHARACTERS.replace(name, "_")
    name = WHITESPACE.replace(name, " ").trim(' ', '.', '_')

    if (name.endsWith(".zip", ignoreCase = true)) name = name.dropLast(4)
    if (name.isBlank()) return "archive.zip"

    val points = name.codePoints().toArray()
    if (points.size > MAX_NAME_CODE_POINTS) {
        name = String(points, 0, MAX_NAME_CODE_POINTS).trimEnd(' ', '.', '_')
    }
    if (name.isBlank()) return "archive.zip"
    return "$name.zip"
}

/** Pick a name that does not overwrite an earlier archive in the folder. */
fun uniqueArchiveFile(directory: File, fileName: String): File {
    val first = File(directory, fileName)
    if (!first.exists()) return first

    val base = fileName.removeSuffix(".zip")
    for (number in 2..999) {
        val candidate = File(directory, "$base ($number).zip")
        if (!candidate.exists()) return candidate
    }
    return File(directory, "$base-${System.currentTimeMillis()}.zip")
}

/**
 * Read the file name from a `Content-Disposition` header.
 *
 * `filename*=UTF-8''…` wins over the ASCII fallback. A plus in an RFC 5987
 * value is a literal plus, not a space.
 */
fun fileNameFromDisposition(header: String?): String? {
    if (header.isNullOrBlank()) return null

    val encoded = Regex(
        """filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)""",
        RegexOption.IGNORE_CASE,
    ).find(header)?.groupValues?.get(1)
    if (encoded != null) {
        val value = encoded.trim().trim('"')
        val decoded = runCatching {
            URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
        }.getOrDefault(value)
        return decoded.takeIf { it.isNotBlank() }
    }

    val quoted = Regex("""filename\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE)
        .find(header)?.groupValues?.get(1)
    if (quoted != null) return quoted.takeIf { it.isNotBlank() }

    return Regex("""filename\s*=\s*([^;]+)""", RegexOption.IGNORE_CASE)
        .find(header)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotBlank() }
}

/** App-specific Downloads folder, which needs no storage permission. */
fun archiveDirectory(context: Context): File {
    val base = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
    return File(base, "Remagnet").apply { mkdirs() }
}

/** Delete a partial file without masking the original failure. */
fun deleteQuietly(file: File?) {
    if (file == null) return
    runCatching { file.delete() }
}
