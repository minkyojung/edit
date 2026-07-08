import React from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { App } from './App'
import { LAST_PATH_STORAGE_KEY } from './hooks/usePersistLastPath'
import { projectStorageKey, WINDOW_ROOT } from './lib/windowRoot'
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

// Auto-update: run the check loop only in the launcher window (no `root`
// param), and only in production builds. All windows of the app share one
// process and one app bundle, so a single checker is enough — gating to one
// window avoids redundant downloads and concurrent installs replacing the
// same .app. Dev builds skip it: there's no installed bundle to replace and
// no release to find, so check() would just spam the network and warn.
if (WINDOW_ROOT === null && import.meta.env.PROD) {
  void import('./lib/updater').then(({ startAutoUpdate }) => startAutoUpdate())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
