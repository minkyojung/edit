// Encrypted file storage for secrets (OAuth tokens, etc.).
//
// Why not keychain: macOS prompts for permission on every read in dev,
// and even shipped apps that use keychain often re-prompt after OS updates.
// Many production apps (VS Code's electron variant, Discord, Notion) keep
// secrets in their own encrypted file. This is that pattern.
//
// Threat model:
//  - Random reader of the file: blocked (AES-GCM)
//  - Same-machine other app: blocked unless it can also read machine-uid
//    (effectively the same trust boundary as the user's account)
//  - Forensic adversary with disk image: blocked unless they also extract
//    the same machine-uid → essentially requires live-machine compromise
//  - File copied to another machine: complete fail to decrypt (different uid)

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

const KEY_SALT: &[u8] = b"writer-tauri.secure-storage.v1";

fn derive_key() -> Result<[u8; 32], String> {
    let machine_id =
        machine_uid::get().map_err(|e| format!("failed to read machine id: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(KEY_SALT);
    hasher.update(machine_id.as_bytes());
    Ok(hasher.finalize().into())
}

fn storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir)
}

fn file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(storage_dir(app)?.join(format!("{name}.enc")))
}

pub fn save(app: &AppHandle, name: &str, plaintext: &[u8]) -> Result<(), String> {
    let key = derive_key()?;
    let cipher = Aes256Gcm::new((&key).into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt failed: {e}"))?;

    let mut bytes = Vec::with_capacity(12 + ciphertext.len());
    bytes.extend_from_slice(nonce.as_slice());
    bytes.extend_from_slice(&ciphertext);

    let path = file_path(app, name)?;
    fs::write(&path, bytes).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(())
}

pub fn load(app: &AppHandle, name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = file_path(app, name)?;
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    if bytes.len() < 12 {
        return Err("stored payload too short".to_string());
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let key = derive_key()?;
    let cipher = Aes256Gcm::new((&key).into());
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))?;
    Ok(Some(plaintext))
}

pub fn delete(app: &AppHandle, name: &str) -> Result<(), String> {
    let path = file_path(app, name)?;
    match fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {}", path.display(), e)),
    }
}
