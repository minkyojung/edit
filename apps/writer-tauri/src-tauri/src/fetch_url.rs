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

use reqwest::{Client, Url};

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
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

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<FetchedPage, String> {
    let parsed = Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("unsupported scheme: {scheme}"));
    }
    if let Some(host) = parsed.host_str() {
        if is_private_host(host) {
            return Err(format!("blocked private host: {host}"));
        }
    } else {
        return Err("URL has no host".to_string());
    }

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
    let body = decoded
        .trim_start_matches('\u{FEFF}')
        .trim_start()
        .to_string();

    Ok(FetchedPage {
        url: final_url,
        status,
        content_type,
        body,
    })
}
