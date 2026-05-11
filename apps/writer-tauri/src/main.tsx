import React from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { App } from './App'
import { bootstrapEditorDebug } from './lib/editorDebug'
import './index.css'

// Install console/error capture + window.__editorDump before anything
// renders so the buffer has a chance to catch boot-time problems.
bootstrapEditorDebug()

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
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
