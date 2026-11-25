use std::{
    collections::HashSet,
    future::Future,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};

use anyhow::{bail, Context as _, Result};
use axum::body::Bytes;
use futures_lite::Stream;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tokio::io::{AsyncWriteExt, DuplexStream};
use tokio_util::io::ReaderStream;

use crate::{
    backend::{ArchiveFile, ArchiveTorrent, FileByteStream, TorrentBackend},
    error::AppError,
};

/// APPNOTE 4.3.7: local file header before the name and extra fields.
const LOCAL_HEADER_FIXED_SIZE: u64 = 30;
/// APPNOTE 4.3.9: streaming data descriptor without ZIP64 size fields.
const DATA_DESCRIPTOR_SIZE: u64 = 16;
/// APPNOTE 4.3.9.2: streaming data descriptor with 64-bit size fields.
const DATA_DESCRIPTOR_ZIP64_SIZE: u64 = 24;
/// APPNOTE 4.3.12: central directory header before the name and extra fields.
const CENTRAL_HEADER_FIXED_SIZE: u64 = 46;
/// APPNOTE 4.3.14: ZIP64 end of central directory record.
const ZIP64_EOCD_SIZE: u64 = 56;
/// APPNOTE 4.3.15: ZIP64 end of central directory locator.
const ZIP64_EOCD_LOCATOR_SIZE: u64 = 20;
/// APPNOTE 4.3.16: end of central directory record.
const EOCD_SIZE: u64 = 22;
/// APPNOTE 4.5.3: extra field id for ZIP64 extended information.
const ZIP64_EXTRA_ID: u16 = 0x0001;
/// APPNOTE 4.5.3: id, payload length, and two 64-bit sizes in a local header.
const LOCAL_ZIP64_EXTRA_SIZE: u16 = 20;
/// Longest torrent name, in characters, used in the suggested ZIP filename.
const MAX_ZIP_FILENAME_CHARS: usize = 140;
const VERSION_STANDARD: u16 = 20;
const VERSION_ZIP64: u16 = 45;
/// Bit 3 (data descriptor) and bit 11 (UTF-8 names).
const GENERAL_PURPOSE_FLAGS: u16 = 0x0808;
/// 1980-01-01 00:00:00, the earliest DOS timestamp.
const MODIFIED_DATE: u16 = 0x0021;

/// HTTP body for a ZIP that is still being produced.
///
/// A failed archive task drops the duplex writer, which looks like a clean EOF
/// to a streaming reader. Without this guard a client would treat a truncated
/// body as a complete archive. The success flag is set by [`write_zip`] before
/// it releases the writer, so an EOF without it becomes a stream error and the
/// download fails visibly.
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

/// Name used in Content-Disposition and as the browser's suggested filename.
pub fn zip_filename(torrent_name: &str) -> String {
    let mut base = sanitize_component(torrent_name);
    if !base.chars().any(|character| character.is_alphanumeric()) {
        base.clear();
        base.push_str("torrent");
    }
    base = base.chars().take(MAX_ZIP_FILENAME_CHARS).collect();
    while base.ends_with('.') || base.ends_with(' ') {
        base.pop();
    }
    if base.is_empty() {
        base.push_str("torrent");
    }
    format!("{base}.zip")
}

/// Turn a torrent client file path into a safe path inside the ZIP.
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

/// One entry in an [`ArchivePlan`], with every size and offset resolved.
#[derive(Debug)]
struct PlannedEntry {
    file: ArchiveFile,
    name: String,
    name_len: u16,
    local_header_offset: u64,
    local_zip64: bool,
    need_size64: bool,
    need_offset64: bool,
    cd_zip64: bool,
    cd_extra_payload: u16,
    cd_extra_len: u16,
    cd_header_size: u64,
}

/// The exact byte layout of a stored ZIP before any file bytes are read.
///
/// Entry names are deduplicated and every header, data descriptor and central
/// directory record is sized here, so the HTTP response can send a precise
/// `Content-Length` and the writer can verify that it produced exactly that
/// many bytes. All arithmetic is checked because torrents may exceed 4 GiB.
#[derive(Debug)]
pub struct ArchivePlan {
    entries: Vec<PlannedEntry>,
    cd_offset: u64,
    cd_size: u64,
    needs_zip64_eocd: bool,
    content_length: u64,
}

impl ArchivePlan {
    pub fn new(files: Vec<ArchiveFile>) -> Result<Self, AppError> {
        Self::new_with_limit(files, u64::from(u32::MAX))
    }

    /// Build a plan with a lower ZIP64 threshold, for tests that cannot write
    /// four gigabytes. Production callers use [`ArchivePlan::new`].
    fn new_with_limit(files: Vec<ArchiveFile>, zip64_limit: u64) -> Result<Self, AppError> {
        let mut used_names = HashSet::new();
        let mut entries = Vec::with_capacity(files.len());
        let mut offset = 0u64;

        for file in files {
            let name = unique_entry_name(zip_entry_name(&file.name, file.index), &mut used_names);
            let name_len = u16::try_from(name.len()).map_err(|_| {
                AppError::BadRequest(
                    "A file name is too long to include in the ZIP archive.".to_string(),
                )
            })?;

            let local_zip64 = file.size >= zip64_limit;
            let local_extra_len = if local_zip64 {
                u64::from(LOCAL_ZIP64_EXTRA_SIZE)
            } else {
                0
            };
            let local_header_size = LOCAL_HEADER_FIXED_SIZE
                .checked_add(u64::from(name_len))
                .and_then(|size| size.checked_add(local_extra_len))
                .ok_or_else(zip_layout_overflow)?;
            let descriptor_size = if local_zip64 {
                DATA_DESCRIPTOR_ZIP64_SIZE
            } else {
                DATA_DESCRIPTOR_SIZE
            };

            let local_header_offset = offset;
            offset = offset
                .checked_add(local_header_size)
                .and_then(|size| size.checked_add(file.size))
                .and_then(|size| size.checked_add(descriptor_size))
                .ok_or_else(zip_layout_overflow)?;

            let need_size64 = file.size >= zip64_limit;
            let need_offset64 = local_header_offset >= zip64_limit;
            let cd_zip64 = need_size64 || need_offset64;
            let cd_extra_payload =
                (if need_size64 { 16u16 } else { 0 }) + (if need_offset64 { 8u16 } else { 0 });
            let cd_extra_len = if cd_zip64 { 4 + cd_extra_payload } else { 0 };
            let cd_header_size = CENTRAL_HEADER_FIXED_SIZE
                .checked_add(u64::from(name_len))
                .and_then(|size| size.checked_add(u64::from(cd_extra_len)))
                .ok_or_else(zip_layout_overflow)?;

            entries.push(PlannedEntry {
                file,
                name,
                name_len,
                local_header_offset,
                local_zip64,
                need_size64,
                need_offset64,
                cd_zip64,
                cd_extra_payload,
                cd_extra_len,
                cd_header_size,
            });
        }

        let cd_offset = offset;
        let cd_size = entries
            .iter()
            .try_fold(0u64, |total, entry| total.checked_add(entry.cd_header_size))
            .ok_or_else(zip_layout_overflow)?;
        let entry_count = entries.len() as u64;
        let needs_zip64_eocd = entry_count >= u64::from(u16::MAX)
            || cd_size >= zip64_limit
            || cd_offset >= zip64_limit;

        let mut content_length = cd_offset
            .checked_add(cd_size)
            .ok_or_else(zip_layout_overflow)?;
        if needs_zip64_eocd {
            content_length = content_length
                .checked_add(ZIP64_EOCD_SIZE)
                .and_then(|size| size.checked_add(ZIP64_EOCD_LOCATOR_SIZE))
                .ok_or_else(zip_layout_overflow)?;
        }
        content_length = content_length
            .checked_add(EOCD_SIZE)
            .ok_or_else(zip_layout_overflow)?;

        Ok(Self {
            entries,
            cd_offset,
            cd_size,
            needs_zip64_eocd,
            content_length,
        })
    }

    /// Exact number of bytes the streaming writer will produce.
    pub fn content_length(&self) -> u64 {
        self.content_length
    }
}

fn zip_layout_overflow() -> AppError {
    AppError::internal("the archive layout exceeds the 64-bit ZIP limits")
}

type OpenFileFuture<'a> =
    Pin<Box<dyn Future<Output = Result<FileByteStream, AppError>> + Send + 'a>>;

/// Where [`write_plan`] gets the bytes for one planned entry.
///
/// The production implementation asks the torrent client; tests substitute an
/// in-memory source so the full byte layout can be verified without upstreams.
trait ArchiveSource {
    fn open<'a>(&'a self, file: &'a ArchiveFile) -> OpenFileFuture<'a>;
}

struct BackendSource<'a> {
    backend: &'a TorrentBackend,
    torrent: &'a ArchiveTorrent,
}

impl ArchiveSource for BackendSource<'_> {
    fn open<'a>(&'a self, file: &'a ArchiveFile) -> OpenFileFuture<'a> {
        Box::pin(async move { self.backend.open_file(self.torrent, file).await })
    }
}

/// Write the torrent's files into a ZIP stream.
///
/// Each file is streamed from the configured torrent client (or its mounted
/// downloads volume) and copied into an entry as it arrives, so the proxy never
/// buffers a whole file. This module has no client-specific coupling.
pub async fn write_zip(
    writer: DuplexStream,
    backend: TorrentBackend,
    torrent: ArchiveTorrent,
    plan: ArchivePlan,
    success: Arc<AtomicBool>,
) -> Result<()> {
    let source = BackendSource {
        backend: &backend,
        torrent: &torrent,
    };
    write_plan(writer, plan, source, success).await
}

async fn write_plan<S: ArchiveSource>(
    writer: DuplexStream,
    plan: ArchivePlan,
    source: S,
    success: Arc<AtomicBool>,
) -> Result<()> {
    let mut writer = writer;
    let mut written_total = 0u64;
    let mut crcs = Vec::with_capacity(plan.entries.len());

    for entry in &plan.entries {
        write_bytes(&mut writer, &local_header(entry), &mut written_total).await?;

        let mut hasher = crc32fast::Hasher::new();
        let mut written = 0u64;

        let mut stream = source.open(&entry.file).await.with_context(|| {
            format!("could not open {} from the torrent client", entry.file.name)
        })?;

        while let Some(chunk) = futures_lite::StreamExt::next(&mut stream).await {
            let chunk = chunk.with_context(|| {
                format!("could not read {} from the torrent client", entry.file.name)
            })?;
            written = written
                .checked_add(chunk.len() as u64)
                .context("the file is too large to describe in ZIP64")?;
            hasher.update(&chunk);
            write_bytes(&mut writer, &chunk, &mut written_total).await?;
        }

        if written != entry.file.size {
            bail!(
                "The torrent client sent {written} of {} bytes for {}",
                entry.file.size,
                entry.file.name
            );
        }

        let crc = hasher.finalize();
        write_bytes(
            &mut writer,
            &data_descriptor(entry, crc),
            &mut written_total,
        )
        .await?;
        crcs.push(crc);
    }

    for (entry, crc) in plan.entries.iter().zip(crcs) {
        write_bytes(&mut writer, &central_header(entry, crc), &mut written_total).await?;
    }

    let entry_count = plan.entries.len() as u64;
    if plan.needs_zip64_eocd {
        write_bytes(
            &mut writer,
            &zip64_eocd(entry_count, plan.cd_size, plan.cd_offset),
            &mut written_total,
        )
        .await?;
        let locator_offset = plan
            .cd_offset
            .checked_add(plan.cd_size)
            .context("the archive layout exceeds the 64-bit ZIP limits")?;
        write_bytes(
            &mut writer,
            &zip64_eocd_locator(locator_offset),
            &mut written_total,
        )
        .await?;
    }
    write_bytes(
        &mut writer,
        &eocd(entry_count, plan.cd_size, plan.cd_offset),
        &mut written_total,
    )
    .await?;

    writer
        .shutdown()
        .await
        .context("could not close the ZIP stream")?;

    if written_total != plan.content_length() {
        bail!(
            "The ZIP stream wrote {written_total} bytes but the plan described {}",
            plan.content_length()
        );
    }

    // Set only after the archive is complete but before the writer is dropped,
    // so the reader can tell success from an aborted stream.
    success.store(true, Ordering::SeqCst);
    Ok(())
}

async fn write_bytes(writer: &mut DuplexStream, bytes: &[u8], total: &mut u64) -> Result<()> {
    writer
        .write_all(bytes)
        .await
        .context("could not write to the ZIP stream")?;
    *total = total
        .checked_add(bytes.len() as u64)
        .context("the ZIP stream exceeded 64-bit offsets")?;
    Ok(())
}

fn local_header(entry: &PlannedEntry) -> Vec<u8> {
    let name = entry.name.as_bytes();
    let extra_len = if entry.local_zip64 {
        LOCAL_ZIP64_EXTRA_SIZE
    } else {
        0
    };
    let size_field = if entry.local_zip64 { u32::MAX } else { 0 };

    let mut header =
        Vec::with_capacity(LOCAL_HEADER_FIXED_SIZE as usize + name.len() + usize::from(extra_len));
    header.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    header.extend_from_slice(
        &(if entry.local_zip64 {
            VERSION_ZIP64
        } else {
            VERSION_STANDARD
        })
        .to_le_bytes(),
    );
    header.extend_from_slice(&GENERAL_PURPOSE_FLAGS.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&MODIFIED_DATE.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&size_field.to_le_bytes());
    header.extend_from_slice(&size_field.to_le_bytes());
    header.extend_from_slice(&entry.name_len.to_le_bytes());
    header.extend_from_slice(&extra_len.to_le_bytes());
    header.extend_from_slice(name);

    if entry.local_zip64 {
        header.extend_from_slice(&ZIP64_EXTRA_ID.to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
    }

    header
}

fn data_descriptor(entry: &PlannedEntry, crc: u32) -> Vec<u8> {
    let descriptor_size = if entry.local_zip64 {
        DATA_DESCRIPTOR_ZIP64_SIZE
    } else {
        DATA_DESCRIPTOR_SIZE
    };
    let mut descriptor = Vec::with_capacity(descriptor_size as usize);
    descriptor.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
    descriptor.extend_from_slice(&crc.to_le_bytes());
    if entry.local_zip64 {
        descriptor.extend_from_slice(&entry.file.size.to_le_bytes());
        descriptor.extend_from_slice(&entry.file.size.to_le_bytes());
    } else {
        descriptor.extend_from_slice(&(entry.file.size as u32).to_le_bytes());
        descriptor.extend_from_slice(&(entry.file.size as u32).to_le_bytes());
    }
    descriptor
}

fn central_header(entry: &PlannedEntry, crc: u32) -> Vec<u8> {
    let name = entry.name.as_bytes();
    let version = if entry.cd_zip64 {
        VERSION_ZIP64
    } else {
        VERSION_STANDARD
    };
    let size_field = if entry.need_size64 {
        u32::MAX
    } else {
        entry.file.size as u32
    };
    let offset_field = if entry.need_offset64 {
        u32::MAX
    } else {
        entry.local_header_offset as u32
    };

    let mut header = Vec::with_capacity(
        CENTRAL_HEADER_FIXED_SIZE as usize + name.len() + usize::from(entry.cd_extra_len),
    );
    header.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    header.extend_from_slice(&((3u16 << 8) | version).to_le_bytes());
    header.extend_from_slice(&version.to_le_bytes());
    header.extend_from_slice(&GENERAL_PURPOSE_FLAGS.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&MODIFIED_DATE.to_le_bytes());
    header.extend_from_slice(&crc.to_le_bytes());
    header.extend_from_slice(&size_field.to_le_bytes());
    header.extend_from_slice(&size_field.to_le_bytes());
    header.extend_from_slice(&entry.name_len.to_le_bytes());
    header.extend_from_slice(&entry.cd_extra_len.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&(0o100644u32 << 16).to_le_bytes());
    header.extend_from_slice(&offset_field.to_le_bytes());
    header.extend_from_slice(name);

    if entry.cd_zip64 {
        header.extend_from_slice(&ZIP64_EXTRA_ID.to_le_bytes());
        header.extend_from_slice(&entry.cd_extra_payload.to_le_bytes());
        if entry.need_size64 {
            header.extend_from_slice(&entry.file.size.to_le_bytes());
            header.extend_from_slice(&entry.file.size.to_le_bytes());
        }
        if entry.need_offset64 {
            header.extend_from_slice(&entry.local_header_offset.to_le_bytes());
        }
    }

    header
}

fn zip64_eocd(entry_count: u64, cd_size: u64, cd_offset: u64) -> Vec<u8> {
    let mut record = Vec::with_capacity(ZIP64_EOCD_SIZE as usize);
    record.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
    record.extend_from_slice(&44u64.to_le_bytes());
    record.extend_from_slice(&((3u16 << 8) | VERSION_ZIP64).to_le_bytes());
    record.extend_from_slice(&VERSION_ZIP64.to_le_bytes());
    record.extend_from_slice(&0u32.to_le_bytes());
    record.extend_from_slice(&0u32.to_le_bytes());
    record.extend_from_slice(&entry_count.to_le_bytes());
    record.extend_from_slice(&entry_count.to_le_bytes());
    record.extend_from_slice(&cd_size.to_le_bytes());
    record.extend_from_slice(&cd_offset.to_le_bytes());
    record
}

fn zip64_eocd_locator(zip64_eocd_offset: u64) -> Vec<u8> {
    let mut locator = Vec::with_capacity(ZIP64_EOCD_LOCATOR_SIZE as usize);
    locator.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
    locator.extend_from_slice(&0u32.to_le_bytes());
    locator.extend_from_slice(&zip64_eocd_offset.to_le_bytes());
    locator.extend_from_slice(&1u32.to_le_bytes());
    locator
}

fn eocd(entry_count: u64, cd_size: u64, cd_offset: u64) -> Vec<u8> {
    let count = entry_count.min(u64::from(u16::MAX)) as u16;
    let mut record = Vec::with_capacity(EOCD_SIZE as usize);
    record.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    record.extend_from_slice(&0u16.to_le_bytes());
    record.extend_from_slice(&0u16.to_le_bytes());
    record.extend_from_slice(&count.to_le_bytes());
    record.extend_from_slice(&count.to_le_bytes());
    record.extend_from_slice(&(cd_size.min(u64::from(u32::MAX)) as u32).to_le_bytes());
    record.extend_from_slice(&(cd_offset.min(u64::from(u32::MAX)) as u32).to_le_bytes());
    record.extend_from_slice(&0u16.to_le_bytes());
    record
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
    use std::{
        collections::HashMap,
        io::{Cursor, Read as _},
    };

    use super::*;
    use crate::backend::validate_hash;

    fn archive_file(index: i64, name: &str, size: u64) -> ArchiveFile {
        ArchiveFile {
            index,
            name: name.to_string(),
            size,
            progress: 1.0,
        }
    }

    fn contents(items: &[(i64, &[u8])]) -> HashMap<i64, Vec<u8>> {
        items
            .iter()
            .map(|(index, bytes)| (*index, bytes.to_vec()))
            .collect()
    }

    struct MemorySource {
        contents: HashMap<i64, Vec<u8>>,
    }

    impl ArchiveSource for MemorySource {
        fn open<'a>(&'a self, file: &'a ArchiveFile) -> OpenFileFuture<'a> {
            let bytes = self.contents.get(&file.index).cloned().unwrap_or_default();
            Box::pin(async move {
                let chunks: Vec<io::Result<Bytes>> = vec![Ok(Bytes::from(bytes))];
                Ok(Box::pin(futures_lite::stream::iter(chunks)) as FileByteStream)
            })
        }
    }

    async fn render(
        files: Vec<ArchiveFile>,
        contents: HashMap<i64, Vec<u8>>,
        zip64_limit: u64,
    ) -> (u64, Vec<u8>, bool, Result<()>) {
        let plan = ArchivePlan::new_with_limit(files, zip64_limit).unwrap();
        let expected = plan.content_length();
        let (writer, mut reader) = tokio::io::duplex(64 * 1024);
        let success = Arc::new(AtomicBool::new(false));
        let task_success = Arc::clone(&success);
        let source = MemorySource { contents };
        let task =
            tokio::spawn(async move { write_plan(writer, plan, source, task_success).await });

        let mut output = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut output)
            .await
            .unwrap();
        let result = task.await.unwrap();

        (expected, output, success.load(Ordering::SeqCst), result)
    }

    fn assert_entries(output: &[u8], expected: &[(&str, &[u8])]) {
        let mut archive = zip::ZipArchive::new(Cursor::new(output.to_vec())).unwrap();
        assert_eq!(archive.len(), expected.len());
        for (name, bytes) in expected {
            let mut entry = archive.by_name(name).unwrap();
            assert_eq!(entry.crc32(), crc32fast::hash(bytes));
            assert_eq!(entry.unix_mode().map(|mode| mode & 0o777), Some(0o644));
            let mut actual = Vec::new();
            entry.read_to_end(&mut actual).unwrap();
            assert_eq!(&actual, *bytes);
        }
    }

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

    #[test]
    fn plans_exact_standard_layout_bytes() {
        let plan = ArchivePlan::new(vec![archive_file(0, "a.txt", 3)]).unwrap();
        // 30 + 5 header, 3 data, 16 descriptor, 46 + 5 central, 22 EOCD.
        assert_eq!(plan.content_length(), 127);
    }

    #[test]
    fn rejects_entry_names_that_do_not_fit_in_u16() {
        let name = format!("{}.bin", "a".repeat(usize::from(u16::MAX)));
        let error = ArchivePlan::new(vec![archive_file(0, &name, 0)]).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }

    #[test]
    fn plans_files_past_four_gibibytes_without_overflow() {
        let plan = ArchivePlan::new(vec![
            archive_file(0, "first.bin", u64::from(u32::MAX)),
            archive_file(1, "second.bin", 1),
        ])
        .unwrap();
        assert!(plan.content_length() > u64::from(u32::MAX));
        assert!(!plan.entries[0].need_offset64);
        assert!(plan.entries[0].need_size64);
        assert!(plan.entries[1].need_offset64);
        assert!(!plan.entries[1].need_size64);
    }

    #[tokio::test]
    async fn writes_a_single_stored_file() {
        let files = vec![archive_file(0, "Show/Episode.mkv", 5)];
        let (expected, output, success, result) =
            render(files, contents(&[(0, b"hello")]), u64::from(u32::MAX)).await;

        result.unwrap();
        assert!(success);
        assert_eq!(output.len() as u64, expected);
        assert_entries(&output, &[("Show/Episode.mkv", b"hello")]);
    }

    #[tokio::test]
    async fn writes_an_empty_file() {
        let files = vec![archive_file(0, "empty.txt", 0)];
        let (expected, output, success, result) =
            render(files, contents(&[(0, b"")]), u64::from(u32::MAX)).await;

        result.unwrap();
        assert!(success);
        assert_eq!(output.len() as u64, expected);
        assert_entries(&output, &[("empty.txt", b"")]);
    }

    #[tokio::test]
    async fn writes_multiple_files() {
        let files = vec![
            archive_file(0, "Show/one.txt", 5),
            archive_file(1, "Show/two.bin", 4),
        ];
        let (expected, output, success, result) = render(
            files,
            contents(&[(0, b"first"), (1, b"data")]),
            u64::from(u32::MAX),
        )
        .await;

        result.unwrap();
        assert!(success);
        assert_eq!(output.len() as u64, expected);
        assert_entries(
            &output,
            &[("Show/one.txt", b"first"), ("Show/two.bin", b"data")],
        );
    }

    #[tokio::test]
    async fn preserves_utf8_entry_names() {
        let files = vec![archive_file(0, "Amélie/日本語.txt", 3)];
        let (expected, output, success, result) =
            render(files, contents(&[(0, b"yes")]), u64::from(u32::MAX)).await;

        result.unwrap();
        assert!(success);
        assert_eq!(output.len() as u64, expected);
        assert_entries(&output, &[("Amélie/日本語.txt", b"yes")]);
    }

    #[tokio::test]
    async fn deduplicates_entries_before_sizing() {
        let files = vec![
            archive_file(0, "Show/episode.mkv", 3),
            archive_file(1, "Show/episode.mkv", 4),
        ];
        let (expected, output, success, result) = render(
            files,
            contents(&[(0, b"one"), (1, b"two!")]),
            u64::from(u32::MAX),
        )
        .await;

        result.unwrap();
        assert!(success);
        assert_eq!(output.len() as u64, expected);
        assert_entries(
            &output,
            &[
                ("Show/episode.mkv", b"one"),
                ("Show/episode (2).mkv", b"two!"),
            ],
        );
    }

    #[tokio::test]
    async fn forced_zip64_layout_round_trips() {
        let files = vec![archive_file(0, "large.bin", 5)];
        let (expected, output, success, result) =
            render(files, contents(&[(0, b"hello")]), 1).await;

        result.unwrap();
        assert!(success);
        // 59 header (name + ZIP64 extra), 5 data, 24 descriptor,
        // 75 central header (ZIP64 extra), 56 + 20 ZIP64 EOCD, 22 EOCD.
        assert_eq!(expected, 261);
        assert_eq!(output.len() as u64, expected);
        assert_entries(&output, &[("large.bin", b"hello")]);
    }

    #[tokio::test]
    async fn mismatched_file_size_aborts_without_success() {
        let files = vec![archive_file(0, "short.bin", 5)];
        let (expected, output, success, result) =
            render(files, contents(&[(0, b"hi")]), u64::from(u32::MAX)).await;

        assert!(result.is_err());
        assert!(!success);
        assert!(output.len() < expected as usize);
    }
}
