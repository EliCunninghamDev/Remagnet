package dev.remagnet.app.client

/**
 * A typed outcome for every network call.
 *
 * Screens render [Failure] explicitly, so a request that fails can never leave
 * a spinner running or a blank list with no explanation.
 */
sealed interface QbitResult<out T> {
    data class Success<out T>(val value: T) : QbitResult<T>

    data class Failure(val error: QbitError) : QbitResult<Nothing>
}

/** A user-readable failure from the qBittorrent client. */
sealed class QbitError(val message: String, val code: String? = null) {
    /** The settings needed for a request are missing or malformed. */
    class InvalidSettings(message: String, code: String? = null) : QbitError(message, code)

    /** The client rejected the API key, session or login attempt. */
    class Unauthorized(message: String, code: String? = null) : QbitError(message, code)

    /** The host could not be reached at all. */
    class Unreachable(message: String, code: String? = null) : QbitError(message, code)

    /** The client answered with an unexpected status. */
    class Http(val status: Int, message: String, code: String? = null) : QbitError(message, code)

    /** The client answered, but refused the torrent itself. */
    class Rejected(message: String, code: String? = null) : QbitError(message, code)

    /** The response was not the shape the Web API documents. */
    class InvalidResponse(message: String, code: String? = null) : QbitError(message, code)
}

fun <T> QbitResult<T>.valueOrNull(): T? = (this as? QbitResult.Success)?.value

fun <T> QbitResult<T>.errorOrNull(): QbitError? = (this as? QbitResult.Failure)?.error
