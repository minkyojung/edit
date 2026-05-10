// Bridge between Tauri (Rust host) and the Node sidecar processes.
// See ../../sidecar/PROTOCOL.md.

pub mod client;
pub mod commands;
mod framing;
pub mod manager;
