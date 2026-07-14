import React from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { App } from './App'
import './index.css'

// Session restore now happens in docsStore.bootstrap (post-scan), not here:
// the last view is persisted by PATH, and resolving a path to this boot's
// fresh (ephemeral) slug needs the scanned catalog, which doesn't exist
// pre-mount. See lib/lastView + bootstrapSlice.

// Cmd+R → reload, Cmd+Option+I → devtools (dev only)
if (import.meta.env.DEV) {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey && e.key === 'r') {
      e.preventDefault()
      location.reload()
    }
  })
  // Expose Tauri primitives for ad-hoc verification from the dev console.
  ;(window as unknown as { __tauri: { invoke: typeof invoke; listen: typeof listen } }).__tauri = {
    invoke,
    listen,
  }
  // Side-effect import: registers window.__inbox / window.__processInbox /
  // window.__syncToday so the Claude Code-native intake runners can be
  // exercised on real captures from the dev console. Production builds skip
  // this block entirely.
  void import('./agent/inbox')
  // Same pattern: registers window.__captureYoutube so the full capture
  // pipeline (fetch → create → frontmatter flush) can be run from the
  // dev console before the capture UI lands.
  void import('./state/youtubeService')
}

// Auto-update now lives in Rust (src-tauri/src/updater.rs): a single
// process-wide checker runs in the backend regardless of which window is
// open, and every window subscribes via useUpdaterEvents() in App(). No
// startup wiring needed here anymore.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
