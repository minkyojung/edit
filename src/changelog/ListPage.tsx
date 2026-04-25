import { Link } from 'react-router-dom'
import { entries } from './entries'
import { formatDate } from './format'

export default function ListPage() {
  return (
    <div className="cl-root">
      <div className="cl-container">
        <header className="cl-header">
          <Link to="/" className="cl-brand">.octave</Link>
          <nav className="cl-nav">Changelog</nav>
        </header>

        <h1 className="cl-page-title">Changelog</h1>
        <p className="cl-page-sub">
          New features, improvements, and fixes shipped in Octave.
        </p>

        {entries.length === 0 ? (
          <div className="cl-empty">No entries yet.</div>
        ) : (
          entries.map((entry) => (
            <article key={entry.slug} className="cl-entry">
              <div className="cl-meta">
                <time>{formatDate(entry.date)}</time>
                {entry.tags.map((t) => (
                  <span key={t} className={`cl-tag cl-tag-${t}`}>{t}</span>
                ))}
              </div>
              <h2 className="cl-title">
                <Link to={`/changelog/${entry.slug}`}>{entry.title}</Link>
              </h2>
              <p className="cl-desc">{entry.description}</p>
            </article>
          ))
        )}
      </div>
    </div>
  )
}
