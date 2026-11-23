use std::{collections::HashSet, path::PathBuf, pin::Pin};

use axum::body::Bytes;
use futures_lite::Stream;
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;
use url::Url;

use crate::{config::Config, error::AppError, qbit::QbitClient, transmission::TransmissionClient};

const COMPLETE_EPSILON: f64 = 0.999_999;

/// The torrent client the proxy is configured to talk to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    #[default]
    Qbittorrent,
    Transmission,
}

impl ClientKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Qbittorrent => "qBittorrent",
            Self::Transmission => "Transmission",
        }
    }

    /// Parse a client name from configuration or the environment, tolerating
    /// common spellings and casing.
    pub fn from_str_loose(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "qbittorrent" | "qbit" | "qb" => Some(Self::Qbittorrent),
            "transmission" | "tr" => Some(Self::Transmission),
            _ => None,
        }
    }
}

/// A torrent in the client-neutral shape shared by the extension and Android.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentSummary {
    pub hash: String,
    pub name: String,
    pub state: String,
    pub progress: f64,
    pub size: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub eta: i64,
    pub ratio: f64,
    pub category: String,
    pub tags: Vec<String>,
    pub seeds: u64,
    pub peers: u64,
}

/// Features the proxy exposes for the torrent client it adapts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentCapabilities {
    pub pause_on_add: bool,
    pub archive_download: bool,
    pub categories: bool,
    pub tags: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentList {
    pub torrents: Vec<TorrentSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentRequest {
    pub urls: Vec<String>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentResult {
    pub added: usize,
    pub hashes: Vec<String>,
    pub category: String,
    pub tags: Vec<String>,
}

/// Connection details and feature set reported by the configured client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendHealth {
    pub client_label: String,
    pub app_version: String,
    pub web_api_version: String,
    pub capabilities: TorrentCapabilities,
}

/// Completion-relevant fields needed to build a read-only archive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTorrent {
    pub hash: String,
    pub name: String,
    pub progress: f64,
    pub amount_left: u64,
    pub state: String,
    pub category: String,
    pub tags: Vec<String>,
    pub download_dir: Option<String>,
}

impl ArchiveTorrent {
    /// Whether the torrent is owned by Remagnet under the configured defaults.
    pub fn matches_filter(&self, default_category: &str, default_tags: &[String]) -> bool {
        matches_ownership(&self.category, &self.tags, default_category, default_tags)
    }
}

/// One file inside a torrent, with enough data to size and verify the ZIP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFile {
    pub index: i64,
    pub name: String,
    pub size: u64,
    pub progress: f64,
}

/// A streaming byte source for one torrent file.
pub type FileByteStream = Pin<Box<dyn Stream<Item = std::io::Result<Bytes>> + Send>>;

/// Whether a torrent is fully downloaded and safe to archive.
pub fn torrent_completed(torrent: &ArchiveTorrent) -> bool {
    torrent.progress >= COMPLETE_EPSILON
        && torrent.amount_left == 0
        && !matches!(torrent.state.as_str(), "missingFiles" | "error")
}

/// Whether a torrent is owned by Remagnet under the configured defaults.
///
/// Category and tag matching is case-insensitive, mirroring qBittorrent and the
/// extension's relevance filter. When both defaults are empty, every torrent
/// matches.
pub fn matches_torrent_filter(
    torrent: &TorrentSummary,
    default_category: &str,
    default_tags: &[String],
) -> bool {
    matches_ownership(
        &torrent.category,
        &torrent.tags,
        default_category,
        default_tags,
    )
}

fn matches_ownership(
    torrent_category: &str,
    torrent_tags: &[String],
    default_category: &str,
    default_tags: &[String],
) -> bool {
    let default_category = default_category.trim();
    let tags = default_tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();

    if default_category.is_empty() && tags.is_empty() {
        return true;
    }

    if !default_category.is_empty() && fold(torrent_category) == fold(default_category) {
        return true;
    }

    let folded_tags = torrent_tags
        .iter()
        .map(|tag| fold(tag))
        .collect::<HashSet<_>>();
    tags.iter().any(|tag| folded_tags.contains(&fold(tag)))
}

/// Extract the v1/v2 info hashes embedded in `magnet:` URLs.
pub fn extract_magnet_hashes(urls: &[String]) -> Vec<String> {
    urls.iter().filter_map(|url| info_hash(url)).collect()
}

fn info_hash(url: &str) -> Option<String> {
    let parsed = Url::parse(url.trim()).ok()?;
    if !parsed.scheme().eq_ignore_ascii_case("magnet") {
        return None;
    }

    let mut btih = None;
    let mut btmh = None;
    for (key, value) in parsed.query_pairs() {
        if !key.eq_ignore_ascii_case("xt") {
            continue;
        }

        let value = value.trim().to_ascii_lowercase();
        if let Some(hash) = value.strip_prefix("urn:btih:") {
            if btih.is_none() {
                btih = parse_btih(hash);
            }
        } else if let Some(hash) = value.strip_prefix("urn:btmh:") {
            if btmh.is_none() {
                btmh = parse_btmh(hash);
            }
        }
    }

    btih.or(btmh)
}

fn parse_btih(hash: &str) -> Option<String> {
    if hash.len() == 40 && is_hex(hash) {
        return Some(hash.to_string());
    }
    if hash.len() == 32 {
        return base32_to_hex(hash);
    }
    None
}

fn parse_btmh(hash: &str) -> Option<String> {
    let hash = hash
        .strip_prefix("1220")
        .filter(|rest| rest.len() == 64)
        .unwrap_or(hash);
    (hash.len() == 64 && is_hex(hash)).then(|| hash.to_string())
}

fn is_hex(value: &str) -> bool {
    value.chars().all(|character| character.is_ascii_hexdigit())
}

fn base32_to_hex(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(20);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for character in value.chars() {
        let digit = match character.to_ascii_uppercase() {
            'A'..='Z' => character.to_ascii_uppercase() as u32 - 'A' as u32,
            '2'..='7' => character as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | digit;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= if bits == 0 { 0 } else { (1 << bits) - 1 };
        }
    }

    if bytes.len() != 20 {
        return None;
    }

    Some(
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}

fn fold(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Maps a torrent client's absolute paths onto a mounted downloads volume.
///
/// The proxy never needs write access to the volume: archives are streamed
/// read-only. Every resolved path is canonicalized and checked against the
/// configured root so symlinks or traversal cannot escape it.
#[derive(Debug, Clone)]
pub struct VolumeMapper {
    downloads_dir: Option<PathBuf>,
    client_downloads_dir: Option<String>,
}

impl VolumeMapper {
    pub fn new(downloads_dir: Option<PathBuf>, client_downloads_dir: Option<String>) -> Self {
        Self {
            downloads_dir,
            client_downloads_dir,
        }
    }

    pub fn from_config(config: &Config) -> Self {
        let downloads_dir = config.downloads_dir.trim();
        let client_downloads_dir = config.client_downloads_dir.trim();
        Self::new(
            (!downloads_dir.is_empty()).then(|| PathBuf::from(downloads_dir)),
            (!client_downloads_dir.is_empty()).then(|| client_downloads_dir.to_string()),
        )
    }

    pub fn is_configured(&self) -> bool {
        self.downloads_dir.is_some()
    }

    /// Resolve one torrent file inside the mounted volume.
    pub async fn resolve_file(
        &self,
        torrent_download_dir: Option<&str>,
        relative_file: &str,
    ) -> Result<PathBuf, AppError> {
        let root = self.downloads_dir.as_ref().ok_or_else(|| {
            AppError::ServiceUnavailable(
                "Downloads directory is not configured. Mount the torrent client's downloads volume read-only and set DOWNLOADS_DIR to stream ZIP archives."
                    .to_string(),
            )
        })?;

        let relative = safe_relative_path(relative_file)?;

        let mut resolved = root.clone();
        if let Some(client_root) = self.client_downloads_dir.as_deref() {
            if let Some(torrent_dir) = torrent_download_dir
                .map(str::trim)
                .filter(|dir| !dir.is_empty())
            {
                if let Some(nested) = strip_client_root(torrent_dir, client_root) {
                    if !nested.is_empty() {
                        let nested = safe_relative_path(&nested)?;
                        resolved.push(nested);
                    }
                }
            }
        }
        resolved.push(relative);

        let canonical_root = tokio::fs::canonicalize(root).await.map_err(|error| {
            AppError::NotFound(format!(
                "The mounted downloads directory is unavailable: {error}"
            ))
        })?;
        let canonical_file = tokio::fs::canonicalize(&resolved).await.map_err(|error| {
            AppError::NotFound(format!(
                "File not found in the mounted downloads directory: {error}"
            ))
        })?;

        if !canonical_file.starts_with(&canonical_root) {
            return Err(AppError::Forbidden(
                "The resolved file is outside the mounted downloads directory.".to_string(),
            ));
        }

        Ok(canonical_file)
    }

    /// Open one torrent file as a streaming byte source.
    pub async fn open_file(
        &self,
        torrent_download_dir: Option<&str>,
        relative_file: &str,
    ) -> Result<FileByteStream, AppError> {
        let path = self
            .resolve_file(torrent_download_dir, relative_file)
            .await?;
        let file = tokio::fs::File::open(&path).await.map_err(|error| {
            AppError::internal(format!("could not open the torrent file: {error}"))
        })?;
        Ok(Box::pin(ReaderStream::with_capacity(file, 256 * 1024)))
    }
}

/// Keep only path components that stay relative and inside the root.
fn safe_relative_path(value: &str) -> Result<PathBuf, AppError> {
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(AppError::BadRequest(
            "Torrent file paths must be relative.".to_string(),
        ));
    }

    let mut path = PathBuf::new();
    for (index, part) in normalized.split('/').enumerate() {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::BadRequest(
                "Torrent file paths cannot contain '..'.".to_string(),
            ));
        }
        if index == 0 && looks_like_windows_prefix(part) {
            return Err(AppError::BadRequest(
                "Torrent file paths cannot include a drive prefix.".to_string(),
            ));
        }
        path.push(part);
    }

    if path.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "A torrent file path is required.".to_string(),
        ));
    }

    Ok(path)
}

fn looks_like_windows_prefix(part: &str) -> bool {
    let bytes = part.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Strip the client's downloads root from a torrent's download directory.
///
/// Returns the nested subdirectory (possibly empty) when the torrent directory
/// lives under the client root. Prefix matching respects path boundaries, so
/// `/downloads2` is not treated as `/downloads`.
fn strip_client_root(dir: &str, client_root: &str) -> Option<String> {
    let mut dir = dir.replace('\\', "/");
    while dir.ends_with('/') && dir.len() > 1 {
        dir.pop();
    }

    let mut root = client_root.replace('\\', "/");
    while root.ends_with('/') && root.len() > 1 {
        root.pop();
    }
    let root = root.as_str();

    if root.is_empty() {
        return Some(dir);
    }
    if dir == root {
        return Some(String::new());
    }

    let rest = dir.strip_prefix(root)?;
    if !rest.starts_with('/') {
        return None;
    }
    Some(rest.trim_start_matches('/').to_string())
}

/// A configured torrent client, selected from the saved configuration.
#[derive(Clone)]
pub enum TorrentBackend {
    Qbittorrent(QbitClient),
    Transmission(TransmissionClient),
}

impl TorrentBackend {
    /// Build the configured backend, or `None` when setup is incomplete.
    pub fn from_config(config: &Config) -> anyhow::Result<Option<Self>> {
        if !config.has_credentials() {
            return Ok(None);
        }

        match config.client_kind {
            ClientKind::Qbittorrent => Ok(Some(Self::Qbittorrent(QbitClient::new(config)?))),
            ClientKind::Transmission => {
                Ok(Some(Self::Transmission(TransmissionClient::new(config)?)))
            }
        }
    }

    pub async fn test_connection(&self) -> Result<BackendHealth, AppError> {
        match self {
            Self::Qbittorrent(client) => client.test_connection().await,
            Self::Transmission(client) => client.test_connection().await,
        }
    }

    pub async fn list_torrents(&self) -> Result<Vec<TorrentSummary>, AppError> {
        match self {
            Self::Qbittorrent(client) => client.list_torrents().await,
            Self::Transmission(client) => client.list_torrents().await,
        }
    }

    pub async fn get_torrent(&self, hash: &str) -> Result<Option<TorrentSummary>, AppError> {
        match self {
            Self::Qbittorrent(client) => client.get_torrent(hash).await,
            Self::Transmission(client) => client.get_torrent(hash).await,
        }
    }

    pub async fn add_torrents(
        &self,
        urls: &[String],
        category: &str,
        tags: &[String],
        paused: bool,
    ) -> Result<AddTorrentResult, AppError> {
        match self {
            Self::Qbittorrent(client) => client.add_torrent(urls, category, tags, paused).await,
            Self::Transmission(client) => client.add_torrent(urls, category, tags, paused).await,
        }
    }

    pub async fn remove_torrent(&self, hash: &str, delete_files: bool) -> Result<(), AppError> {
        match self {
            Self::Qbittorrent(client) => client.remove_torrent(hash, delete_files).await,
            Self::Transmission(client) => client.remove_torrent(hash, delete_files).await,
        }
    }

    pub async fn archive_torrent(&self, hash: &str) -> Result<ArchiveTorrent, AppError> {
        match self {
            Self::Qbittorrent(client) => Ok(client.torrent(hash).await?.archive()),
            Self::Transmission(client) => client.archive_torrent(hash).await,
        }
    }

    pub async fn files(&self, hash: &str) -> Result<Vec<ArchiveFile>, AppError> {
        match self {
            Self::Qbittorrent(client) => Ok(client
                .files(hash)
                .await?
                .into_iter()
                .map(ArchiveFile::from)
                .collect()),
            Self::Transmission(client) => client.files(hash).await,
        }
    }

    pub async fn open_file(
        &self,
        torrent: &ArchiveTorrent,
        file: &ArchiveFile,
    ) -> Result<FileByteStream, AppError> {
        match self {
            Self::Qbittorrent(client) => client.open_file(torrent, file).await,
            Self::Transmission(client) => client.open_file(torrent, file).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_lite::StreamExt;

    use super::*;

    fn torrent(category: &str, tags: &[&str]) -> TorrentSummary {
        TorrentSummary {
            hash: "a".repeat(40),
            name: "Example".to_string(),
            state: "seeding".to_string(),
            progress: 1.0,
            size: 10,
            download_speed: 0,
            upload_speed: 0,
            eta: 0,
            ratio: 1.0,
            category: category.to_string(),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            seeds: 1,
            peers: 1,
        }
    }

    fn archive_torrent(progress: f64, amount_left: u64, state: &str) -> ArchiveTorrent {
        ArchiveTorrent {
            hash: "a".repeat(40),
            name: "Example".to_string(),
            progress,
            amount_left,
            state: state.to_string(),
            category: "remagnet".to_string(),
            tags: vec!["remagnet".to_string()],
            download_dir: None,
        }
    }

    #[test]
    fn client_kinds_have_labels_and_loose_parsing() {
        assert_eq!(ClientKind::Qbittorrent.label(), "qBittorrent");
        assert_eq!(ClientKind::Transmission.label(), "Transmission");
        assert_eq!(
            ClientKind::from_str_loose("  qBit "),
            Some(ClientKind::Qbittorrent)
        );
        assert_eq!(
            ClientKind::from_str_loose("TRANSMISSION"),
            Some(ClientKind::Transmission)
        );
        assert_eq!(ClientKind::from_str_loose("deluge"), None);
    }

    #[test]
    fn filters_by_category_or_tag_ignoring_case() {
        let category = "Remagnet";
        let tags = vec!["Nas".to_string()];
        assert!(matches_torrent_filter(
            &torrent("remagnet", &[]),
            category,
            &tags
        ));
        assert!(matches_torrent_filter(
            &torrent("films", &["nas"]),
            category,
            &tags
        ));
        assert!(!matches_torrent_filter(
            &torrent("films", &["other"]),
            category,
            &tags
        ));
    }

    #[test]
    fn empty_defaults_accept_every_torrent() {
        assert!(matches_torrent_filter(&torrent("films", &[]), "", &[]));
        assert!(matches_torrent_filter(
            &torrent("", &[]),
            "  ",
            &["  ".to_string()]
        ));
    }

    #[test]
    fn extracts_v1_and_v2_hashes_from_magnets() {
        let hex = "0123456789abcdef0123456789abcdef01234567";
        let v2 = "0123456789abcdef".repeat(4);
        let urls = vec![
            format!("magnet:?xt=urn:btih:{hex}&dn=test"),
            format!("magnet:?xt=urn:btih:{}", hex.to_uppercase()),
            "magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH".to_string(),
            format!("magnet:?xt=urn:btmh:1220{v2}"),
            "https://example.com/file.torrent".to_string(),
        ];

        assert_eq!(
            extract_magnet_hashes(&urls),
            vec![hex.to_string(), hex.to_string(), hex.to_string(), v2,]
        );
    }

    #[test]
    fn completion_requires_full_progress_and_no_errors() {
        assert!(torrent_completed(&archive_torrent(1.0, 0, "seeding")));
        assert!(!torrent_completed(&archive_torrent(
            0.5,
            512,
            "downloading"
        )));
        assert!(!torrent_completed(&archive_torrent(1.0, 0, "missingFiles")));
        assert!(!torrent_completed(&archive_torrent(1.0, 0, "error")));
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("downloads");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(root.join("Show/Season 1")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("Show/Season 1/file.mkv"), b"episode").unwrap();
        std::fs::write(root.join("root.txt"), b"hello").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        Fixture {
            _directory: directory,
            root,
            outside,
        }
    }

    async fn collect(stream: FileByteStream) -> Vec<u8> {
        let mut stream = stream;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk.unwrap());
        }
        bytes
    }

    #[tokio::test]
    async fn resolves_files_directly_under_the_root() {
        let fixture = fixture();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), None);

        let resolved = volume
            .resolve_file(None, "root.txt")
            .await
            .expect("root.txt resolves");
        assert_eq!(
            resolved,
            tokio::fs::canonicalize(fixture.root.join("root.txt"))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn maps_the_client_root_and_nested_subdirectories() {
        let fixture = fixture();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), Some("/downloads".to_string()));

        let resolved = volume
            .resolve_file(Some("/downloads/Show/Season 1"), "file.mkv")
            .await
            .expect("nested file resolves");
        assert_eq!(
            resolved,
            tokio::fs::canonicalize(fixture.root.join("Show/Season 1/file.mkv"))
                .await
                .unwrap()
        );

        // A torrent saved directly in the client root adds no nested prefix.
        let resolved = volume
            .resolve_file(Some("/downloads/"), "Show/Season 1/file.mkv")
            .await
            .expect("root-level torrent resolves");
        assert_eq!(
            resolved,
            tokio::fs::canonicalize(fixture.root.join("Show/Season 1/file.mkv"))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn rejects_parent_traversal_and_absolute_paths() {
        let fixture = fixture();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), None);

        for bad in ["../outside/secret.txt", "Show/../../outside/secret.txt"] {
            let error = volume.resolve_file(None, bad).await.unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_)),
                "{bad} was accepted"
            );
        }

        for bad in ["/etc/passwd", "C:\\Windows\\system.ini"] {
            let error = volume.resolve_file(None, bad).await.unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_)),
                "{bad} was accepted"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinks_that_escape_the_root() {
        use std::os::unix::fs::symlink;

        let fixture = fixture();
        symlink(
            fixture.outside.join("secret.txt"),
            fixture.root.join("escape.txt"),
        )
        .unwrap();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), None);

        let error = volume.resolve_file(None, "escape.txt").await.unwrap_err();
        assert!(matches!(error, AppError::Forbidden(_)), "{error:?}");
    }

    #[tokio::test]
    async fn missing_files_are_not_found() {
        let fixture = fixture();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), None);

        let error = volume.resolve_file(None, "nope.txt").await.unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)), "{error:?}");
    }

    #[tokio::test]
    async fn unconfigured_volumes_report_service_unavailable() {
        let volume = VolumeMapper::new(None, None);
        assert!(!volume.is_configured());

        let error = volume.resolve_file(None, "file.txt").await.unwrap_err();
        match error {
            AppError::ServiceUnavailable(message) => {
                assert!(message.contains("DOWNLOADS_DIR"));
            }
            other => panic!("expected ServiceUnavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streams_file_bytes() {
        let fixture = fixture();
        let volume = VolumeMapper::new(Some(fixture.root.clone()), None);
        assert!(volume.is_configured());

        let stream = volume
            .open_file(None, "root.txt")
            .await
            .expect("root.txt streams");
        assert_eq!(collect(stream).await, b"hello");
    }
}
