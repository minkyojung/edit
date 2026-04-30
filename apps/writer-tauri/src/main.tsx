import React from 'react'
import ReactDOM from 'react-dom/client'
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
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
