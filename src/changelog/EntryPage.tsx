import { Link, useParams } from 'react-router-dom'
import { findEntry } from './entries'
import { formatDate } from './format'

export default function EntryPage() {
  const { slug } = useParams<{ slug: string }>()
  const entry = slug ? findEntry(slug) : undefined

  if (!entry) {
    return (
      <div className="cl-root">
        <div className="cl-container">
          <header className="cl-header">
            <Link to="/" className="cl-brand">.octave</Link>
            <nav className="cl-nav">
              <Link to="/changelog" style={{ color: '#666', textDecoration: 'none' }}>Changelog</Link>
            </nav>
          </header>
          <Link to="/changelog" className="cl-back">← All entries</Link>
          <h1 className="cl-page-title">Not found</h1>
          <p className="cl-page-sub">This entry does not exist.</p>
        </div>
      </div>
    )
  }

  const Body = entry.Component

  return (
    <div className="cl-root">
      <div className="cl-container">
        <header className="cl-header">
          <Link to="/" className="cl-brand">.octave</Link>
          <nav className="cl-nav">
            <Link to="/changelog" style={{ color: '#666', textDecoration: 'none' }}>Changelog</Link>
          </nav>
        </header>

        <Link to="/changelog" className="cl-back">← All entries</Link>

        <div className="cl-meta">
          <time>{formatDate(entry.date)}</time>
          {entry.tags.map((t) => (
            <span key={t} className={`cl-tag cl-tag-${t}`}>{t}</span>
          ))}
        </div>
        <h1 className="cl-title" style={{ fontSize: 36, marginBottom: 16 }}>{entry.title}</h1>
        <p className="cl-desc" style={{ fontSize: 17, marginBottom: 32 }}>{entry.description}</p>

        <div className="cl-prose">
          <Body />
        </div>
      </div>
    </div>
  )
}
