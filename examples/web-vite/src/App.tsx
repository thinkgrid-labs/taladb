import { useEffect, useState } from 'react'
import { initDB } from './db'
import NotesTab from './components/NotesTab'
import SearchTab from './components/SearchTab'

type Tab = 'notes' | 'search'

export default function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('notes')

  useEffect(() => {
    initDB()
      .then(() => setReady(true))
      .catch((e) => setError(String(e)))
  }, [])

  if (error) {
    return (
      <div className="init-error">
        <div className="init-error-box">
          <span className="init-error-icon">⚠</span>
          <p>Failed to open database</p>
          <code>{error}</code>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="init-loading">
        <div className="spinner" />
        <p>Opening TalaDB…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-brand">
            <span className="app-brand-name">TalaDB</span>
            <span className="app-brand-tag">Playground</span>
          </div>
          <nav className="app-tabs">
            <button
              className={`tab-btn ${activeTab === 'notes' ? 'active' : ''}`}
              onClick={() => setActiveTab('notes')}
            >
              <span className="tab-icon">📝</span>
              Notes
              <span className="tab-sub">Document DB</span>
            </button>
            <button
              className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`}
              onClick={() => setActiveTab('search')}
            >
              <span className="tab-icon">🔍</span>
              Semantic Search
              <span className="tab-sub">Vector DB</span>
            </button>
          </nav>
          <a
            className="app-gh-link"
            href="https://github.com/thinkgrid-labs/taladb"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'notes' && <NotesTab />}
        {activeTab === 'search' && <SearchTab />}
      </main>

      <footer className="app-footer">
        <p>
          Built with <strong>TalaDB</strong> — local-first document + vector database.
          Data lives in your browser via OPFS. No server. No cloud.
        </p>
      </footer>
    </div>
  )
}
