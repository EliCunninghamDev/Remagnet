package dev.remagnet.app.client

/**
 * The operations the app needs from the Remagnet Proxy.
 *
 * The UI and ViewModel depend on this contract, not on the proxy's wire
 * format, and the neutral models in [TorrentModels] stay independent of the
 * generated Retrofit types.
 */
interface TorrentClient {
    suspend fun testConnection(): QbitResult<ConnectionDetails>

    suspend fun listTorrents(): QbitResult<List<TorrentSummary>>

    suspend fun getTorrent(hash: String): QbitResult<TorrentSummary?>

    suspend fun addTorrent(request: AddTorrentRequest): QbitResult<AddTorrentResult>

    suspend fun removeTorrent(
        hashes: List<String>,
        deleteFiles: Boolean = false,
    ): QbitResult<Unit>
}
