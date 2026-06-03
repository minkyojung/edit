//! Tauri command `fetch_url` — GETs a URL and returns the response body.
//!
//! Used by the Profile bootstrap pipeline (frontend `fetchUrlAsMarkdown`)
//! to retrieve blog posts, RSS feeds, and similar text-based public URLs
//! without bouncing off the WebView's CORS policy. The Rust side here is
//! deliberately narrow: HTTPS/HTTP only, body-size cap, request timeout,
//! private-IP blocked (SSRF guard), redirect limit. Anything fancier
//! (paywall handling, JS rendering, auth) is out of scope — this is a
//! plain-old GET.
//!
//! All errors surface as `Result<_, String>` so the frontend gets a
//! short human-readable reason for any failure. The frontend logs
//! these to console and shows them in the Profile Review UI.
use std::net::IpAddr;
use std::time::Duration;

use base64::Engine as _;
use reqwest::{Client, Url};

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
// Larger cap for binary assets (article images): a single page hero or
// diagram can exceed the 5 MB text cap. Still bounded so a runaway
// download can't exhaust memory.
const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 10;
const REDIRECT_LIMIT: usize = 5;
// Browser-prefixed UA. Substack / Medium / Cloudflare-fronted hosts
// 403 anything that doesn't look like a browser, while still
// accepting identifiable "compatible; X" suffixes (the convention
// Googlebot / Feedly / etc. use). Without the Mozilla prefix the
// /feed endpoints come back as anti-bot HTML pages instead of
// RSS. Honest but compatible.
const USER_AGENT: &str =
    "Mozilla/5.0 (compatible; Writer/0.1; +https://github.com/minkyojung/edit)";

#[derive(serde::Serialize)]
pub struct FetchedPage {
    /// Final URL after redirects (may differ from the requested one).
    pub url: String,
    pub status: u16,
    pub content_type: Option<String>,
    /// UTF-8 decoded body. Invalid UTF-8 is replaced with U+FFFD, not
    /// rejected — the downstream extractor will likely cope, and we'd
    /// rather salvage 99% of bytes than fail on a stray binary blob.
    pub body: String,
}

/// XML 1.0 character class — per the spec, the only allowed code
/// points are #x9 (tab), #xA (newline), #xD (carriage return), and
/// the contiguous ranges #x20–#xD7FF, #xE000–#xFFFD, #x10000–#x10FFFF.
/// Everything else (other ASCII control chars, surrogate halves, the
/// non-character codepoints U+FFFE/U+FFFF) makes a strict XML parser
/// refuse the document. Used by the BOM-strip path to sanitise feed
/// bodies before handing them to the frontend's DOMParser.
fn is_valid_xml_char(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\r'
        | '\u{20}'..='\u{D7FF}'
        | '\u{E000}'..='\u{FFFD}'
        | '\u{10000}'..='\u{10FFFF}'
    )
}

/// SSRF guard. Blocks the obvious "internal" targets so a malicious /
/// mistyped URL can't pivot to localhost services or LAN devices via
/// our Tauri privileges. Public IPs and hostnames fall through.
fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_broadcast()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

/// Parse a URL and enforce the shared safety policy: http(s) only, must
/// have a host, no private/loopback targets (SSRF guard). Shared by
/// `fetch_url` and `fetch_binary` so both honour identical rules.
fn parse_public_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("unsupported scheme: {scheme}"));
    }
    match parsed.host_str() {
        Some(host) if is_private_host(host) => {
            return Err(format!("blocked private host: {host}"))
        }
        None => return Err("URL has no host".to_string()),
        _ => {}
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<FetchedPage, String> {
    let parsed = parse_public_url(&url)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(REDIRECT_LIMIT))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("client init: {e}"))?;

    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("body read: {e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!(
            "response too large: {} bytes (cap {MAX_BODY_BYTES})",
            bytes.len()
        ));
    }
    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    // Strip the UTF-8 BOM (U+FEFF) and any other leading whitespace
    // before `<?xml ...?>`. The browser's strict XML parser (text/xml)
    // refuses to parse a document with garbage in front of the
    // declaration — even a single invisible BOM byte aborts the parse
    // and the only signal we get back is a generic "parsererror"
    // element with no line/column info. Many CDN-fronted feeds (Substack,
    // Cloudflare-cached WordPress) emit BOMs; strip here so the
    // frontend never has to think about it.
    let trimmed = decoded.trim_start_matches('\u{FEFF}').trim_start();
    // Strip XML 1.0 invalid characters (control chars except tab /
    // newline / carriage return, plus the U+FFFE/U+FFFF non-character
    // codepoints). Real-world RSS bodies routinely contain stray
    // 0x08 backspace bytes — usually copy-pasted from terminals or
    // legacy editors — which the strict parser correctly rejects.
    // Industry-standard RSS readers all do this sanitisation pass.
    let body: String = trimmed
        .chars()
        .filter(|&c| is_valid_xml_char(c))
        .collect();

    Ok(FetchedPage {
        url: final_url,
        status,
        content_type,
        body,
    })
}

#[derive(serde::Serialize)]
pub struct FetchedBinary {
    /// Final URL after redirects.
    pub url: String,
    pub status: u16,
    pub content_type: Option<String>,
    /// Base64-encoded raw bytes. The frontend decodes to a Uint8Array
    /// and writes it via writeVaultBinary. Base64 (not a JSON byte
    /// array) keeps the IPC payload compact for multi-MB images.
    pub base64: String,
}

/// GET a binary asset (article image, etc.) and return it base64-encoded.
/// Same safety policy as `fetch_url` (http(s) only, SSRF guard, timeout,
/// redirect limit) but no UTF-8 decode / XML sanitisation — the bytes are
/// returned verbatim. `referer` sets the Referer header for CDNs that
/// hotlink-block requests without one.
#[tauri::command]
pub async fn fetch_binary(
    url: String,
    referer: Option<String>,
) -> Result<FetchedBinary, String> {
    let parsed = parse_public_url(&url)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(REDIRECT_LIMIT))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("client init: {e}"))?;

    let mut req = client.get(parsed);
    if let Some(r) = referer {
        req = req.header("referer", r);
    }
    let mut resp = req.send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // Early reject when the server advertises an oversized body — skips
    // streaming a payload we'd discard anyway.
    if let Some(len) = resp.content_length() {
        if len > MAX_ASSET_BYTES as u64 {
            return Err(format!(
                "asset too large: {len} bytes (cap {MAX_ASSET_BYTES})"
            ));
        }
    }

    // Stream the body and enforce the cap incrementally. `bytes()` would
    // buffer the *entire* response into memory before any size check, so
    // a runaway or Content-Length-lying server could exhaust memory
    // before being rejected. Accumulate chunk-by-chunk and bail the
    // moment the running total exceeds the cap.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("body read: {e}"))? {
        if buf.len() + chunk.len() > MAX_ASSET_BYTES {
            return Err(format!("asset too large: exceeds cap {MAX_ASSET_BYTES} bytes"));
        }
        buf.extend_from_slice(&chunk);
    }
    let base64 = base64::engine::general_purpose::STANDARD.encode(&buf);

    Ok(FetchedBinary {
        url: final_url,
        status,
        content_type,
        base64,
    })
}
