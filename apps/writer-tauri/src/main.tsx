import React from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { App } from './App'
import { LAST_PATH_STORAGE_KEY } from './hooks/usePersistLastPath'
import { projectStorageKey } from './lib/windowRoot'
import './index.css'

// Session restore: if the WebView came up with an empty / root hash
// (cold relaunch, fresh install, or Tauri reset), reapply the last
// pathname we saw before quit. Runs before React mounts so HashRouter
// reads the restored hash on its very first render — no flash of the
// "today's daily" fallback before the real last-viewed doc lands.
//
// The reconciler in RouteSyncBridge validates the restored slug against
// knownDocs after bootstrap, so a stale path (deleted doc, vault swap)
// can't corrupt state — it will redirect to today's daily.
;(() => {
  try {
    const currentHash = window.location.hash.replace(/^#/, '')
    if (currentHash && currentHash !== '/') return
    const saved = localStorage.getItem(projectStorageKey(LAST_PATH_STORAGE_KEY))
    if (!saved) return
    window.location.hash = saved
  } catch {
    // Same swallow as the writer hook — restore is best-effort.
  }
})()

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
  // Side-effect import: registers window.__ingest so the ingest engine
  // can be exercised from the dev console while we tune the prompt.
  // Production builds skip this block entirely.
  void import('./agent/ingest')
  // Same pattern: registers window.__route so the inbox→wiki/daily router
  // PoC can be eyeballed on real captures from the dev console.
  void import('./agent/ingestRouter')
  // Same pattern: registers window.__processInbox so the Claude Code-native
  // inbox intake runner can be exercised on real captures from the console.
  void import('./agent/inbox')
  // Same pattern: registers window.__captureYoutube so the full capture
  // pipeline (fetch → create → frontmatter flush) can be run from the
  // dev console before the capture UI lands.
  void import('./state/youtubeService')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
