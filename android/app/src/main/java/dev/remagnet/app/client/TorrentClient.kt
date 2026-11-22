package dev.remagnet.app.client

/**
 * The operations the app needs from any torrent client.
 *
 * The UI and ViewModel depend on this contract, not on qBittorrent's wire
 * format. A second client would implement the same interface and reuse the
 * neutral models in [TorrentModels].
 */
interface TorrentClient {
    suspend fun testConnection(): QbitResult<ConnectionDetails>

    suspend fun listTorrents(): QbitResult<List<TorrentSummary>>

    suspend fun getTorrent(hash: String): QbitResult<TorrentSummary?>

    suspend fun getTaxonomy(): QbitResult<TorrentTaxonomy>

    suspend fun addTorrent(request: AddTorrentRequest): QbitResult<AddTorrentResult>

    suspend fun removeTorrent(
        hashes: List<String>,
        deleteFiles: Boolean = false,
    ): QbitResult<Unit>
}
