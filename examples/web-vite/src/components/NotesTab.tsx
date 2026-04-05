import { useEffect, useRef, useState } from 'react'
import { db } from '../db'
import type { Note } from '../db'

const CATEGORIES = ['Personal', 'Work', 'Research', 'Ideas']

function tagList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export default function NotesTab() {
  const [notes, setNotes] = useState<Note[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)
  const tagsRef = useRef<HTMLInputElement>(null)

  const col = db().collection<Note>('notes')

  async function loadNotes() {
    let results: Note[]

    if (query && filterCategory) {
      const byBody = await col.find({ body: { $contains: query }, category: filterCategory })
      const byTitle = await col.find({ title: { $contains: query }, category: filterCategory })
      const seen = new Set(byBody.map((n) => n._id))
      results = [...byBody, ...byTitle.filter((n) => !seen.has(n._id))]
    } else if (query) {
      const byBody = await col.find({ body: { $contains: query } })
      const byTitle = await col.find({ title: { $contains: query } })
      const seen = new Set(byBody.map((n) => n._id))
      results = [...byBody, ...byTitle.filter((n) => !seen.has(n._id))]
    } else if (filterCategory) {
      results = await col.find({ category: filterCategory })
    } else {
      results = await col.find()
    }

    results.sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
    setNotes(results)
    setTotal(await col.count())
  }

  useEffect(() => {
    loadNotes()
  }, [query, filterCategory])

  useEffect(() => {
    const unsub = col.subscribe({}, () => {
      loadNotes()
    })
    return unsub
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const title = titleRef.current!.value.trim()
    const body = bodyRef.current!.value.trim()
    if (!title || !body) return

    setSaving(true)
    await col.insert({
      title,
      body,
      category: categoryRef.current!.value,
      tags: tagList(tagsRef.current!.value),
      createdAt: Date.now(),
    })
    setSaving(false)
    setShowForm(false)
    titleRef.current!.value = ''
    bodyRef.current!.value = ''
    tagsRef.current!.value = ''
  }

  async function handleDelete(id: string) {
    await col.deleteOne({ _id: id })
  }

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div className="toolbar-left">
          <div className="stat-badge">
            <span className="stat-value">{total}</span>
            <span className="stat-label">notes stored</span>
          </div>
        </div>
        <div className="toolbar-right">
          <input
            className="search-input"
            placeholder="Search notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="filter-select"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New note'}
          </button>
        </div>
      </div>

      {showForm && (
        <form className="note-form" onSubmit={handleSave}>
          <div className="form-row">
            <input
              ref={titleRef}
              className="form-input"
              placeholder="Title"
              required
            />
            <select ref={categoryRef} className="form-select">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <textarea
            ref={bodyRef}
            className="form-textarea"
            placeholder="Write your note here…"
            rows={4}
            required
          />
          <div className="form-row">
            <input
              ref={tagsRef}
              className="form-input"
              placeholder="Tags (comma-separated)"
            />
            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </form>
      )}

      {notes.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">📭</span>
          <p>
            {query || filterCategory
              ? 'No notes match your search.'
              : 'No notes yet — create your first one!'}
          </p>
        </div>
      ) : (
        <div className="notes-grid">
          {notes.map((note) => (
            <NoteCard key={note._id} note={note} onDelete={handleDelete} />
          ))}
        </div>
      )}

      <div className="feature-strip">
        <span className="feature-pill">createIndex('category')</span>
        <span className="feature-pill">createIndex('_fts:body')</span>
        <span className="feature-pill">$contains filter</span>
        <span className="feature-pill">subscribe() live updates</span>
        <span className="feature-pill">OPFS persistence</span>
      </div>
    </div>
  )
}

function NoteCard({ note, onDelete }: { note: Note; onDelete: (id: string) => void }) {
  const date = new Date(note.createdAt as number).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="note-card">
      <div className="note-card-header">
        <span className={`category-badge cat-${(note.category as string).toLowerCase()}`}>
          {note.category as string}
        </span>
        <button
          className="delete-btn"
          onClick={() => onDelete(note._id!)}
          aria-label="Delete note"
        >
          ✕
        </button>
      </div>
      <h3 className="note-title">{note.title as string}</h3>
      <p className="note-body">{note.body as string}</p>
      {(note.tags as string[]).length > 0 && (
        <div className="note-tags">
          {(note.tags as string[]).map((t) => (
            <span key={t} className="tag">#{t}</span>
          ))}
        </div>
      )}
      <p className="note-date">{date}</p>
    </div>
  )
}
