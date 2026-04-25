import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ListPage from './ListPage'
import EntryPage from './EntryPage'
import '../index.css'
import './changelog.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/changelog" element={<ListPage />} />
        <Route path="/changelog/:slug" element={<EntryPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
