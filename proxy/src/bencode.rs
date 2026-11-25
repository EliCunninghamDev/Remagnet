//! Zero-dependency bencode parsing for uploaded `.torrent` files.
//!
//! Only the top-level dictionary and its `info` value are interpreted. The
//! parser still walks every value so malformed bencode, duplicate keys that
//! break the structure, and trailing bytes are rejected before the info hash is
//! computed.

use sha1::{Digest as _, Sha1};
use sha2::Sha256;

use crate::{backend::to_hex, error::AppError};

/// Largest `.torrent` metainfo file the proxy will accept.
pub const MAX_TORRENT_FILE_BYTES: usize = 10 * 1024 * 1024;

/// Guard against pathological nesting before the recursive parser exhausts the
/// stack. Real torrents are only a handful of levels deep.
const MAX_DEPTH: usize = 64;

/// The value kinds bencode can represent, with the parsed integer payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueKind {
    Integer(i64),
    ByteString,
    List,
    Dictionary,
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn invalid(message: impl Into<String>) -> AppError {
        AppError::BadRequest(message.into())
    }

    /// Parse one bencoded value and return its kind.
    fn parse_value(&mut self, depth: usize) -> Result<ValueKind, AppError> {
        if depth > MAX_DEPTH {
            return Err(Self::invalid(
                "The .torrent file is nested too deeply to read.",
            ));
        }

        match self.peek() {
            Some(b'i') => self.parse_integer().map(ValueKind::Integer),
            Some(b'l') => {
                self.pos += 1;
                loop {
                    match self.peek() {
                        Some(b'e') => {
                            self.pos += 1;
                            return Ok(ValueKind::List);
                        }
                        Some(_) => {
                            self.parse_value(depth + 1)?;
                        }
                        None => {
                            return Err(Self::invalid(
                                "The .torrent file ends in the middle of a list.",
                            ));
                        }
                    }
                }
            }
            Some(b'd') => {
                self.parse_dictionary(depth + 1)?;
                Ok(ValueKind::Dictionary)
            }
            Some(b'0'..=b'9') => {
                self.parse_byte_string()?;
                Ok(ValueKind::ByteString)
            }
            Some(_) => Err(Self::invalid(
                "The .torrent file contains bencode Remagnet Proxy cannot read.",
            )),
            None => Err(Self::invalid("The .torrent file ends unexpectedly.")),
        }
    }

    fn parse_dictionary(&mut self, depth: usize) -> Result<(), AppError> {
        debug_assert_eq!(self.peek(), Some(b'd'));
        self.pos += 1;

        loop {
            match self.peek() {
                Some(b'e') => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(b'0'..=b'9') => {
                    self.parse_byte_string()?;
                    self.parse_value(depth + 1)?;
                }
                Some(_) => {
                    return Err(Self::invalid(
                        "The .torrent file has a dictionary key that is not a byte string.",
                    ));
                }
                None => {
                    return Err(Self::invalid(
                        "The .torrent file ends in the middle of a dictionary.",
                    ));
                }
            }
        }
    }

    fn parse_integer(&mut self) -> Result<i64, AppError> {
        debug_assert_eq!(self.peek(), Some(b'i'));
        self.pos += 1;
        let start = self.pos;

        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let digits_start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        if self.pos == digits_start {
            return Err(Self::invalid(
                "The .torrent file has an integer without digits.",
            ));
        }
        if self.peek() != Some(b'e') {
            return Err(Self::invalid(
                "The .torrent file has an unterminated integer.",
            ));
        }
        if self.bytes[digits_start] == b'0' && self.pos - digits_start > 1 {
            return Err(Self::invalid(
                "The .torrent file has a non-canonical integer.",
            ));
        }

        let text = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| {
            Self::invalid("The .torrent file has an integer Remagnet Proxy cannot read.")
        })?;
        self.pos += 1;
        text.parse::<i64>().map_err(|_| {
            Self::invalid("The .torrent file has an integer outside the supported range.")
        })
    }

    fn parse_byte_string(&mut self) -> Result<&'a [u8], AppError> {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(Self::invalid(
                "The .torrent file has a byte string without a length.",
            ));
        }
        if self.peek() != Some(b':') {
            return Err(Self::invalid(
                "The .torrent file has an unterminated byte string length.",
            ));
        }
        if self.bytes[start] == b'0' && self.pos - start > 1 {
            return Err(Self::invalid(
                "The .torrent file has a non-canonical byte string length.",
            ));
        }

        let length = std::str::from_utf8(&self.bytes[start..self.pos])
            .ok()
            .and_then(|text| text.parse::<usize>().ok())
            .ok_or_else(|| {
                Self::invalid(
                    "The .torrent file has a byte string length Remagnet Proxy cannot read.",
                )
            })?;
        self.pos += 1;

        let end = self.pos.checked_add(length).ok_or_else(|| {
            Self::invalid("The .torrent file has a byte string length that is too large.")
        })?;
        if end > self.bytes.len() {
            return Err(Self::invalid(
                "The .torrent file has a byte string that runs past the end of the file.",
            ));
        }

        let value = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(value)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct InfoDetails {
    has_pieces: bool,
    meta_version: Option<i64>,
}

/// Read the two fields that decide whether the info dictionary is v1 or v2.
fn inspect_info(info: &[u8]) -> Result<InfoDetails, AppError> {
    let mut parser = Parser::new(info);
    if parser.peek() != Some(b'd') {
        return Err(Parser::invalid(
            "The torrent info value must be a bencoded dictionary.",
        ));
    }
    parser.pos += 1;

    let mut details = InfoDetails::default();
    loop {
        match parser.peek() {
            Some(b'e') => {
                parser.pos += 1;
                break;
            }
            Some(b'0'..=b'9') => {
                let key = parser.parse_byte_string()?;
                let kind = parser.parse_value(1)?;
                if key == b"pieces" && kind == ValueKind::ByteString {
                    details.has_pieces = true;
                } else if key == b"meta version" {
                    if let ValueKind::Integer(version) = kind {
                        details.meta_version = Some(version);
                    }
                }
            }
            Some(_) => {
                return Err(Parser::invalid(
                    "The torrent info dictionary has a key that is not a byte string.",
                ));
            }
            None => {
                return Err(Parser::invalid(
                    "The torrent info dictionary ends unexpectedly.",
                ));
            }
        }
    }

    if parser.pos != info.len() {
        return Err(Parser::invalid(
            "The torrent info dictionary has trailing data.",
        ));
    }

    Ok(details)
}

/// Extract the canonical lowercase info hash from raw `.torrent` bytes.
///
/// BitTorrent v1 (and hybrid) torrents use `SHA-1(info)`; v2-only torrents use
/// `SHA-256(info)`. The returned value is 40 or 64 lowercase hex characters.
pub fn extract_info_hash(bytes: &[u8]) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest(
            "The uploaded .torrent file is empty.".to_string(),
        ));
    }
    if bytes.len() > MAX_TORRENT_FILE_BYTES {
        return Err(AppError::PayloadTooLarge(format!(
            "The uploaded .torrent file is too large. The maximum is {} MiB.",
            MAX_TORRENT_FILE_BYTES / (1024 * 1024)
        )));
    }

    let mut parser = Parser::new(bytes);
    if parser.peek() != Some(b'd') {
        return Err(AppError::BadRequest(
            "A .torrent file must be a bencoded dictionary.".to_string(),
        ));
    }
    parser.pos += 1;

    let mut info = None;
    loop {
        match parser.peek() {
            Some(b'e') => {
                parser.pos += 1;
                break;
            }
            Some(b'0'..=b'9') => {
                let key = parser.parse_byte_string()?;
                let start = parser.pos;
                let kind = parser.parse_value(1)?;
                let end = parser.pos;

                if key == b"info" {
                    if kind != ValueKind::Dictionary {
                        return Err(AppError::BadRequest(
                            "The torrent info value must be a bencoded dictionary.".to_string(),
                        ));
                    }
                    if info.is_some() {
                        return Err(AppError::BadRequest(
                            "The .torrent file contains more than one info dictionary.".to_string(),
                        ));
                    }
                    info = Some((start, end));
                }
            }
            Some(_) => {
                return Err(AppError::BadRequest(
                    "The .torrent file has a top-level key that is not a byte string.".to_string(),
                ));
            }
            None => {
                return Err(AppError::BadRequest(
                    "The .torrent file ends in the middle of its root dictionary.".to_string(),
                ));
            }
        }
    }

    if parser.pos != bytes.len() {
        return Err(AppError::BadRequest(
            "The .torrent file has trailing data after the root dictionary.".to_string(),
        ));
    }

    let (start, end) = info.ok_or_else(|| {
        AppError::BadRequest("The .torrent file has no info dictionary.".to_string())
    })?;
    let info_bytes = &bytes[start..end];
    let details = inspect_info(info_bytes)?;

    if details.has_pieces {
        return Ok(to_hex(&Sha1::digest(info_bytes)));
    }
    if details.meta_version == Some(2) {
        return Ok(to_hex(&Sha256::digest(info_bytes)));
    }

    Err(AppError::BadRequest(
        "The .torrent file has neither v1 piece hashes nor BitTorrent v2 metadata.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn byte_string(value: &[u8]) -> Vec<u8> {
        let mut encoded = format!("{}:", value.len()).into_bytes();
        encoded.extend_from_slice(value);
        encoded
    }

    fn text(value: &str) -> Vec<u8> {
        byte_string(value.as_bytes())
    }

    fn v1_info(name: &str, multi_file: bool) -> Vec<u8> {
        let mut info = vec![b'd'];
        if multi_file {
            info.extend(text("files"));
            info.extend_from_slice(b"l");
            info.extend_from_slice(b"d6:lengthi1024e4:pathl");
            info.extend(text("part-one.bin"));
            info.extend_from_slice(b"ee");
            info.extend_from_slice(b"d6:lengthi2048e4:pathl");
            info.extend(text("part-two.bin"));
            info.extend_from_slice(b"eee");
        } else {
            info.extend(text("length"));
            info.extend_from_slice(b"i4096e");
        }
        info.extend(text("name"));
        info.extend(text(name));
        info.extend(text("piece length"));
        info.extend_from_slice(b"i16384e");
        info.extend(text("pieces"));
        info.extend(byte_string(&[0xAB; 20]));
        info.push(b'e');
        info
    }

    fn v2_info(name: &str) -> Vec<u8> {
        let mut info = vec![b'd'];
        info.extend(text("file tree"));
        info.extend_from_slice(b"de");
        info.extend(text("meta version"));
        info.extend_from_slice(b"i2e");
        info.extend(text("name"));
        info.extend(text(name));
        info.extend(text("piece length"));
        info.extend_from_slice(b"i16384e");
        info.push(b'e');
        info
    }

    fn torrent(info: &[u8]) -> Vec<u8> {
        let mut bytes = vec![b'd'];
        bytes.extend(text("announce"));
        bytes.extend(text("udp://tracker.example:80/announce"));
        bytes.extend(text("info"));
        bytes.extend_from_slice(info);
        bytes.push(b'e');
        bytes
    }

    fn expected_sha1(bytes: &[u8]) -> String {
        to_hex(&Sha1::digest(bytes))
    }

    fn expected_sha256(bytes: &[u8]) -> String {
        to_hex(&Sha256::digest(bytes))
    }

    #[test]
    fn extracts_a_v1_single_file_hash() {
        let info = v1_info("debian", false);
        let hash = extract_info_hash(&torrent(&info)).unwrap();

        assert_eq!(hash.len(), 40);
        assert_eq!(hash, expected_sha1(&info));
    }

    #[test]
    fn extracts_a_v1_multi_file_hash() {
        let info = v1_info("collection", true);
        let hash = extract_info_hash(&torrent(&info)).unwrap();

        assert_eq!(hash, expected_sha1(&info));
    }

    #[test]
    fn extracts_a_v2_only_hash() {
        let info = v2_info("debian");
        let hash = extract_info_hash(&torrent(&info)).unwrap();

        assert_eq!(hash.len(), 64);
        assert_eq!(hash, expected_sha256(&info));
    }

    #[test]
    fn hybrid_torrents_use_the_v1_sha1_hash() {
        let mut info = v1_info("hybrid", false);
        // Insert "meta version" before the closing dictionary marker.
        info.pop();
        info.extend(text("meta version"));
        info.extend_from_slice(b"i2e");
        info.push(b'e');

        let hash = extract_info_hash(&torrent(&info)).unwrap();

        assert_eq!(hash.len(), 40);
        assert_eq!(hash, expected_sha1(&info));
    }

    #[test]
    fn rejects_malformed_bencode() {
        let malformed = b"d4:infod4:name4:teste".to_vec();
        let error = extract_info_hash(&malformed).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");

        let unterminated = b"d4:info".to_vec();
        let error = extract_info_hash(&unterminated).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[test]
    fn rejects_a_non_dictionary_root() {
        let error = extract_info_hash(b"i42e").unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[test]
    fn rejects_a_missing_info_dictionary() {
        let bytes = b"d8:announce4:teste".to_vec();
        let error = extract_info_hash(&bytes).unwrap_err();
        match error {
            AppError::BadRequest(message) => assert!(message.contains("no info")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_non_dictionary_info_value() {
        let bytes = b"d4:infoi42ee".to_vec();
        let error = extract_info_hash(&bytes).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[test]
    fn rejects_trailing_bytes_after_the_root_dictionary() {
        let mut bytes = torrent(&v1_info("debian", false));
        bytes.extend_from_slice(b"garbage");

        let error = extract_info_hash(&bytes).unwrap_err();
        match error {
            AppError::BadRequest(message) => assert!(message.contains("trailing data")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_input() {
        let error = extract_info_hash(b"").unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    #[test]
    fn rejects_an_info_dictionary_without_hashes() {
        let mut info = vec![b'd'];
        info.extend(text("name"));
        info.extend(text("plain"));
        info.push(b'e');

        let error = extract_info_hash(&torrent(&info)).unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }
}
