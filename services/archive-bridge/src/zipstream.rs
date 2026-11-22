use std::{
    collections::HashSet,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};

use anyhow::{bail, Context as _, Result};
use async_zip::{tokio::write::ZipFileWriter, Compression, ZipEntryBuilder};
use axum::body::Bytes;
use futures_lite::Stream;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tokio::io::{AsyncWriteExt, DuplexStream};
use tokio_util::io::ReaderStream;

use crate::{
    error::AppError,
    qbit::{QbitClient, TorrentFile},
};

const COMPLETE_EPSILON: f64 = 0.999_999;

/// HTTP body for a ZIP that is still being produced.
///
/// A failed archive task drops the duplex writer, which looks like a clean EOF
/// to a streaming reader. Browsers then save a truncated ZIP as "complete"
/// because the response has no Content-Length. The success flag is set by
/// [`write_zip`] before it releases the writer, so an EOF without it becomes a
/// stream error and the download fails visibly.
pub struct ZipStream {
    inner: ReaderStream<DuplexStream>,
    success: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    ended: bool,
}

impl ZipStream {
    pub fn new(
        inner: ReaderStream<DuplexStream>,
        success: Arc<AtomicBool>,
        failure: Arc<Mutex<Option<String>>>,
    ) -> Self {
        Self {
            inner,
            success,
            failure,
            ended: false,
        }
    }
}

impl Stream for ZipStream {
    type Item = io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(None) if !this.ended => {
                this.ended = true;
                if this.success.load(Ordering::SeqCst) {
                    return Poll::Ready(None);
                }

                let detail = this
                    .failure
                    .lock()
                    .ok()
                    .and_then(|mut slot| slot.take())
                    .unwrap_or_else(|| "the archive stream ended early".to_string());
                Poll::Ready(Some(Err(io::Error::other(detail))))
            }
            other => other,
        }
    }
}

/// qBittorrent v1 hashes are 40 hex characters; v2 hashes are 64.
pub fn validate_hash(hash: &str) -> Result<(), AppError> {
    let hash = hash.trim();
    let valid_length = hash.len() == 40 || hash.len() == 64;
    if valid_length && hash.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Expected a 40 or 64 character hex info hash.".to_string(),
        ))
    }
}

pub fn torrent_completed(torrent: &crate::qbit::TorrentInfo) -> bool {
    torrent.progress >= COMPLETE_EPSILON
        && torrent.amount_left == 0
        && !matches!(torrent.state.as_str(), "missingFiles" | "error")
}

/// Name used in Content-Disposition and as the browser's suggested filename.
pub fn zip_filename(torrent_name: &str) -> String {
    let mut base = sanitize_component(torrent_name);
    if !base.chars().any(|character| character.is_alphanumeric()) {
        base.clear();
        base.push_str("torrent");
    }
    base = base.chars().take(140).collect();
    while base.ends_with('.') || base.ends_with(' ') {
        base.pop();
    }
    if base.is_empty() {
        base.push_str("torrent");
    }
    format!("{base}.zip")
}

/// Turn a qBittorrent file path into a safe path inside the ZIP.
pub fn zip_entry_name(file_name: &str, index: i64) -> String {
    let normalized = file_name.replace('\\', "/");
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(|part| {
            part.chars()
                .map(|character| {
                    if character.is_control() {
                        '_'
                    } else {
                        character
                    }
                })
                .collect::<String>()
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.is_empty() {
        format!("file-{}", index.max(0) + 1)
    } else {
        parts.join("/")
    }
}

pub fn content_disposition(filename: &str) -> String {
    let ascii = filename
        .chars()
        .map(|character| {
            if character.is_ascii()
                && !character.is_ascii_control()
                && character != '"'
                && character != '\\'
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let encoded = utf8_percent_encode(filename, NON_ALPHANUMERIC).to_string();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// Write the torrent's files into a ZIP stream.
///
/// Each file is fetched from qBittorrent's `torrents/downloadFile` endpoint and
/// copied into an entry as it arrives, so the bridge never needs the downloads
/// volume mounted and never buffers a whole file.
pub async fn write_zip(
    writer: DuplexStream,
    qbit: QbitClient,
    hash: String,
    files: Vec<TorrentFile>,
    success: Arc<AtomicBool>,
) -> Result<()> {
    let total_size: u64 = files.iter().map(|file| file.size).sum();
    let needs_zip64 = total_size > u64::from(u32::MAX)
        || files.iter().any(|file| file.size > u64::from(u32::MAX));

    let mut zip = ZipFileWriter::with_tokio(writer);
    if !needs_zip64 {
        // Streaming entries always carry a ZIP64 extra field by default, which
        // some readers (notably Info-ZIP unzip) reject as an overlapping
        // component. Plain data descriptors are enough below 4 GiB.
        zip = zip.force_no_zip64();
    }
    let mut used_names = HashSet::new();

    for file in files {
        let entry_name = unique_entry_name(zip_entry_name(&file.name, file.index), &mut used_names);
        let entry = ZipEntryBuilder::new(entry_name.clone().into(), Compression::Stored)
            .unix_permissions(0o644)
            .build();
        let mut entry_writer = zip
            .write_entry_stream(entry)
            .await
            .with_context(|| format!("could not start ZIP entry {entry_name}"))?;

        let mut written = 0u64;

        let mut response = qbit
            .download_file(&hash, &file.name)
            .await
            .with_context(|| format!("could not open {} from qBittorrent", file.name))?;

        while let Some(chunk) = response
            .chunk()
            .await
            .with_context(|| format!("could not read {} from qBittorrent", file.name))?
        {
            written += chunk.len() as u64;
            futures_lite::io::AsyncWriteExt::write_all(&mut entry_writer, &chunk)
                .await
                .with_context(|| format!("could not write {entry_name} to the ZIP stream"))?;
        }

        if written != file.size {
            bail!(
                "qBittorrent sent {written} of {} bytes for {}",
                file.size,
                file.name
            );
        }

        entry_writer
            .close()
            .await
            .with_context(|| format!("could not finish ZIP entry {entry_name}"))?;
    }

    let mut inner = zip
        .close()
        .await
        .context("could not finish the ZIP archive")?
        .into_inner();
    inner
        .shutdown()
        .await
        .context("could not close the ZIP stream")?;

    // Set only after the archive is complete but before the writer is dropped,
    // so the reader can tell success from an aborted stream.
    success.store(true, Ordering::SeqCst);
    Ok(())
}

fn unique_entry_name(mut name: String, used: &mut HashSet<String>) -> String {
    if used.insert(name.clone()) {
        return name;
    }

    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.clone(), String::new()),
    };

    let mut counter = 2;
    loop {
        name = format!("{stem} ({counter}){extension}");
        if used.insert(name.clone()) {
            return name;
        }
        counter += 1;
    }
}

fn sanitize_component(name: &str) -> String {
    name.trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hashes() {
        assert!(validate_hash("dc555f7a26f1acae38a18edc04e53588ade33051").is_ok());
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        assert!(validate_hash("not-a-hash").is_err());
        assert!(validate_hash(&"g".repeat(40)).is_err());
    }

    #[test]
    fn sanitizes_filenames_and_entries() {
        assert_eq!(zip_filename("Trailer Park Boys"), "Trailer Park Boys.zip");
        assert_eq!(zip_filename("bad/name"), "bad_name.zip");
        assert_eq!(zip_filename("../../"), "torrent.zip");
        assert_eq!(
            zip_entry_name("Show\\Season 1/file.mkv", 0),
            "Show/Season 1/file.mkv"
        );
        assert_eq!(zip_entry_name("../secret", 0), "secret");
        assert_eq!(zip_entry_name("", 4), "file-5");
    }

    #[test]
    fn content_disposition_has_ascii_and_rfc5987_names() {
        let value = content_disposition("Amélie.zip");
        assert!(value.contains("filename=\"Am_lie.zip\""));
        assert!(value.contains("filename*=UTF-8''"));
        assert!(value.contains("%C3%A9"));
    }

    #[test]
    fn deduplicates_entry_names() {
        let mut used = HashSet::new();
        assert_eq!(unique_entry_name("a.txt".to_string(), &mut used), "a.txt");
        assert_eq!(
            unique_entry_name("a.txt".to_string(), &mut used),
            "a (2).txt"
        );
        assert_eq!(
            unique_entry_name("a.txt".to_string(), &mut used),
            "a (3).txt"
        );
    }
}
