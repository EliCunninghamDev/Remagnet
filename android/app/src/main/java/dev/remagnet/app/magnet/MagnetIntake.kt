package dev.remagnet.app.magnet

/** What an incoming `VIEW` or `SEND` intent turned out to contain. */
sealed interface MagnetIntake {
    /** A magnet with a usable BitTorrent v1 info hash. */
    data class Magnet(val uri: String) : MagnetIntake

    /**
     * Text that was meant to be a magnet but cannot be added. The draft is kept
     * so the paste form can show it and let the user fix it.
     */
    data class Unusable(val draft: String, val message: String) : MagnetIntake

    /** A `.torrent` file shared as a `content://` or `file://` URI. */
    data class TorrentFile(val uri: String) : MagnetIntake

    /** Not an intake at all, for example a normal launcher start. */
    data object None : MagnetIntake
}

const val ACTION_VIEW = "android.intent.action.VIEW"
const val ACTION_SEND = "android.intent.action.SEND"
const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

const val NO_HASH_MESSAGE = "That magnet link has no usable BitTorrent info hash."
const val NOT_A_MAGNET_MESSAGE = "That share did not include a magnet link."

/**
 * Extract a magnet or `.torrent` file from the pieces of an intent that matter.
 *
 * Kept free of Android types so the rules can be tested on the JVM. The
 * activity passes `action`, `dataString`, `EXTRA_TEXT`, the shared stream URI
 * and the MIME type in.
 */
fun extractMagnetIntake(
    action: String?,
    data: String?,
    text: String?,
    streamUri: String? = null,
    mimeType: String? = null,
): MagnetIntake {
    val direct = data?.trim().orEmpty()
    val textMagnet = magnetFromText(text)

    if (isMagnetLink(direct)) {
        val link = parseMagnet(direct)
        if (link?.infoHash != null) return MagnetIntake.Magnet(link.uri)

        // A trailing share can carry the usable copy in its text.
        val fromText = textMagnet?.let(::parseMagnet)
        if (fromText?.infoHash != null) return MagnetIntake.Magnet(fromText.uri)
        return MagnetIntake.Unusable(direct, NO_HASH_MESSAGE)
    }

    if (textMagnet != null) {
        val link = parseMagnet(textMagnet)
        if (link?.infoHash != null) return MagnetIntake.Magnet(link.uri)
        return MagnetIntake.Unusable(textMagnet, NO_HASH_MESSAGE)
    }

    if (action == ACTION_VIEW && isFileUri(direct)) {
        return MagnetIntake.TorrentFile(direct)
    }

    val shared = streamUri?.trim().orEmpty()
    if (isShareAction(action) && shared.isNotEmpty()) {
        return MagnetIntake.TorrentFile(shared)
    }

    if (isShareAction(action) && !text.isNullOrBlank()) {
        return MagnetIntake.Unusable(text.trim(), NOT_A_MAGNET_MESSAGE)
    }

    return MagnetIntake.None
}

private fun isShareAction(action: String?): Boolean =
    action == ACTION_SEND || action == ACTION_SEND_MULTIPLE

private fun isFileUri(value: String): Boolean =
    value.startsWith("content://", ignoreCase = true) ||
        value.startsWith("file://", ignoreCase = true)
