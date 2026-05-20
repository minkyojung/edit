import React from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { App } from './App'
import './index.css'

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
  // Same idea — registers window.__bootstrapIngest for verifying the
  // first-run import pipeline before the BootstrapDialog Stage 2
  // caller lands.
  void import('./agent/bootstrapIngest')
  // Registers window.__runImport so the file → bootstrapIngest path
  // is exercisable from DevTools before Stage 2 wires it up.
  void import('./agent/import/runImport')
  // Registers window.__fetchUrlAsMarkdown for verifying the Profile
  // URL fetch + RSS routing path before BootstrapDialog wires it up.
  void import('./agent/profile/fetchUrl')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
