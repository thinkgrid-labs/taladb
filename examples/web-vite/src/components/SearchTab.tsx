import { useEffect, useRef, useState } from 'react'
import { pipeline } from '@xenova/transformers'
import { db, SEED_ARTICLES } from '../db'
import type { Article } from '../db'
import type { VectorSearchResult } from 'taladb'

type ModelStatus = 'idle' | 'downloading' | 'ready' | 'error'

const CATEGORIES = ['All', 'rust', 'webassembly', 'databases', 'ai', 'javascript']

let embedder: ((text: string) => Promise<number[]>) | null = null

export default function SearchTab() {
  const [modelStatus, setModelStatus] = useState<ModelStatus>('idle')
  const [modelProgress, setModelProgress] = useState(0)
  const [seeded, setSeeded] = useState(false)
  const [query, setQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState('All')
  const [results, setResults] = useState<VectorSearchResult<Article>[]>([])
  const [searching, setSearching] = useState(false)
  const [articleCount, setArticleCount] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const col = db().collection<Article>('articles') as any

  async function loadModel() {
    if (embedder) return
    setModelStatus('downloading')
    try {
      const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        progress_callback: (p: { progress?: number; status: string }) => {
          if (p.progress != null) setModelProgress(Math.round(p.progress))
          if (p.status === 'ready') setModelProgress(100)
        },
      })
      embedder = async (text: string) => {
        const out = await pipe(text, { pooling: 'mean', normalize: true })
        return Array.from(out.data as Float32Array)
      }
      setModelStatus('ready')
    } catch (e) {
      console.error('Model load failed', e)
      setModelStatus('error')
    }
  }

  async function seedArticles() {
    const count = await col.count()
    if (count > 0) {
      setArticleCount(count)
      setSeeded(true)
      return
    }

    if (!embedder) return

    for (const article of SEED_ARTICLES) {
      const embedding = await embedder(article.title + ' ' + article.body)
      await col.insert({ ...article, embedding })
    }

    setArticleCount(SEED_ARTICLES.length)
    setSeeded(true)
  }

  useEffect(() => {
    loadModel()
  }, [])

  useEffect(() => {
    if (modelStatus === 'ready') seedArticles()
  }, [modelStatus])

  async function runSearch(q: string, category: string) {
    if (!q.trim() || !embedder || !seeded) {
      setResults([])
      return
    }
    setSearching(true)
    const vec = await embedder(q)
    const filter = category !== 'All' ? { category } : undefined
    const hits = await col.findNearest('embedding', vec, 6, filter as never)
    setResults(hits)
    setSearching(false)
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(val, filterCategory), 350)
  }

  function handleCategoryChange(category: string) {
    setFilterCategory(category)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(query, category), 50)
  }

  return (
    <div className="tab-content">
      <ModelBanner status={modelStatus} progress={modelProgress} />

      <div className="search-hero">
        <p className="search-hero-label">
          {seeded
            ? `${articleCount} articles indexed with 384-dim embeddings · all-MiniLM-L6-v2`
            : modelStatus === 'ready'
            ? 'Generating embeddings…'
            : 'Loading model…'}
        </p>
        <input
          className="search-input-lg"
          placeholder="Ask anything — try 'how to prevent memory bugs' or 'offline apps'"
          value={query}
          onChange={handleQueryChange}
          disabled={!seeded}
        />
        <div className="category-pills">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={`category-pill ${filterCategory === c ? 'active' : ''}`}
              onClick={() => handleCategoryChange(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {filterCategory !== 'All' && query && (
          <p className="hybrid-hint">
            ⚡ Hybrid search — filtering by <strong>{filterCategory}</strong>, then ranking by semantic similarity
          </p>
        )}
      </div>

      {searching && (
        <div className="searching-indicator">
          <div className="spinner spinner-sm" />
          <span>Searching…</span>
        </div>
      )}

      {results.length > 0 && !searching && (
        <div className="results-list">
          {results.map(({ document, score }, i) => (
            <ResultCard key={document._id} article={document} score={score} rank={i + 1} />
          ))}
        </div>
      )}

      {query && results.length === 0 && !searching && seeded && (
        <div className="empty-state">
          <span className="empty-icon">🔎</span>
          <p>No results for "{query}"</p>
        </div>
      )}

      {!query && seeded && (
        <SuggestedQueries onSelect={(q) => { setQuery(q); runSearch(q, filterCategory) }} />
      )}

      <div className="feature-strip">
        <span className="feature-pill">createVectorIndex('embedding', &#123; dimensions: 384 &#125;)</span>
        <span className="feature-pill">findNearest(field, vec, topK)</span>
        <span className="feature-pill">hybrid filter + vector ranking</span>
        <span className="feature-pill">all-MiniLM-L6-v2 on-device</span>
      </div>
    </div>
  )
}

function ModelBanner({ status, progress }: { status: ModelStatus; progress: number }) {
  if (status === 'ready') return null
  if (status === 'error') {
    return (
      <div className="model-banner model-banner-error">
        ⚠ Failed to load the embedding model. Check your network connection and reload.
      </div>
    )
  }
  return (
    <div className="model-banner">
      <div className="model-banner-text">
        <div className="spinner spinner-sm" />
        <span>
          {status === 'idle'
            ? 'Preparing model…'
            : `Downloading all-MiniLM-L6-v2 (~23 MB) · ${progress}%`}
        </span>
      </div>
      <div className="model-progress-bar">
        <div className="model-progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}

function ResultCard({
  article,
  score,
  rank,
}: {
  article: Article
  score: number
  rank: number
}) {
  const pct = Math.round(Math.max(0, Math.min(1, (score + 1) / 2) * 100))

  return (
    <div className="result-card">
      <div className="result-rank">#{rank}</div>
      <div className="result-body">
        <div className="result-header">
          <h3 className="result-title">{article.title}</h3>
          <span className={`category-badge cat-${article.category}`}>{article.category}</span>
        </div>
        <p className="result-excerpt">{article.body}</p>
        <div className="result-score">
          <div className="score-bar-track">
            <div
              className="score-bar-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="score-value">{score.toFixed(3)}</span>
          <span className="score-label">cosine similarity</span>
        </div>
      </div>
    </div>
  )
}

function SuggestedQueries({ onSelect }: { onSelect: (q: string) => void }) {
  const suggestions = [
    'how to prevent memory bugs',
    'offline apps that work without internet',
    'search by meaning not keywords',
    'running code at native speed in the browser',
    'safe concurrency and multithreading',
    'AI models that run without a server',
  ]

  return (
    <div className="suggestions">
      <p className="suggestions-label">Try a query:</p>
      <div className="suggestions-grid">
        {suggestions.map((s) => (
          <button key={s} className="suggestion-btn" onClick={() => onSelect(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
