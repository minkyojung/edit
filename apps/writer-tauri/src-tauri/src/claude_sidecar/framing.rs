// LSP-style framing: `Content-Length: N\r\n\r\n<json>`. Mirrors
// apps/writer-tauri/sidecar/src/jsonrpc.mjs.

const HEADER_END: &[u8] = b"\r\n\r\n";

/// Wraps a JSON payload (already serialized) with framing headers.
pub fn encode(payload: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    let mut out = Vec::with_capacity(header.len() + payload.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(payload);
    out
}

/// Stateful streaming parser. Feed bytes via `push`; pull complete payloads
/// via `next_message`. Tolerates partial reads and multiple messages per chunk.
pub struct FrameParser {
    buf: Vec<u8>,
}

impl FrameParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Pulls one complete payload (the JSON bytes, no headers). Returns None
    /// if no full message is available yet. Discards malformed headers.
    pub fn next_message(&mut self) -> Option<Vec<u8>> {
        loop {
            let header_end = find_subsequence(&self.buf, HEADER_END)?;
            let header_str = match std::str::from_utf8(&self.buf[..header_end]) {
                Ok(s) => s,
                Err(_) => {
                    // Non-utf8 header — discard up to and including the separator.
                    self.buf.drain(..header_end + HEADER_END.len());
                    continue;
                }
            };

            let content_length = match parse_content_length(header_str) {
                Some(n) => n,
                None => {
                    // No Content-Length — skip past this header block.
                    self.buf.drain(..header_end + HEADER_END.len());
                    continue;
                }
            };

            let total = header_end + HEADER_END.len() + content_length;
            if self.buf.len() < total {
                return None;
            }

            let payload = self.buf[header_end + HEADER_END.len()..total].to_vec();
            self.buf.drain(..total);
            return Some(payload);
        }
    }
}

impl Default for FrameParser {
    fn default() -> Self {
        Self::new()
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.split("\r\n") {
        let mut parts = line.splitn(2, ':');
        let name = parts.next()?.trim();
        if name.eq_ignore_ascii_case("Content-Length") {
            let value = parts.next()?.trim();
            return value.parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_single() {
        let payload = br#"{"jsonrpc":"2.0","id":1,"method":"hi"}"#;
        let framed = encode(payload);
        let mut parser = FrameParser::new();
        parser.push(&framed);
        let got = parser.next_message().expect("parse");
        assert_eq!(got, payload);
        assert!(parser.next_message().is_none());
    }

    #[test]
    fn handles_split_chunks() {
        let payload = br#"{"a":1}"#;
        let framed = encode(payload);
        let mut parser = FrameParser::new();
        // Feed bytes one at a time.
        for byte in framed.iter() {
            assert!(parser.next_message().is_none());
            parser.push(std::slice::from_ref(byte));
        }
        let got = parser.next_message().expect("parse");
        assert_eq!(got, payload);
    }

    #[test]
    fn handles_multiple_messages_in_one_chunk() {
        let p1 = br#"{"a":1}"#;
        let p2 = br#"{"b":2}"#;
        let mut combined = encode(p1);
        combined.extend_from_slice(&encode(p2));
        let mut parser = FrameParser::new();
        parser.push(&combined);
        assert_eq!(parser.next_message().unwrap(), p1);
        assert_eq!(parser.next_message().unwrap(), p2);
        assert!(parser.next_message().is_none());
    }

    #[test]
    fn skips_malformed_header_block() {
        // A header block with no Content-Length, followed by a valid message.
        let mut buf = b"X-Custom: nope\r\n\r\n".to_vec();
        buf.extend_from_slice(&encode(br#"{"ok":true}"#));
        let mut parser = FrameParser::new();
        parser.push(&buf);
        assert_eq!(parser.next_message().unwrap(), br#"{"ok":true}"#);
    }

    #[test]
    fn case_insensitive_header() {
        let payload = br#"{"x":1}"#;
        let mut framed = format!("content-LENGTH: {}\r\n\r\n", payload.len()).into_bytes();
        framed.extend_from_slice(payload);
        let mut parser = FrameParser::new();
        parser.push(&framed);
        assert_eq!(parser.next_message().unwrap(), payload);
    }
}
