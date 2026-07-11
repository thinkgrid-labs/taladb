'use client';

import { useState } from 'react';
import { useCollection, useFind } from '@taladb/react';

interface Note {
  _id?: string;
  text: string;
  createdAt: number;
  [key: string]: string | number | undefined;
}

export default function Home() {
  const notes = useCollection<Note>('notes');
  const { data, loading } = useFind(notes); // live query — synced changes appear automatically
  const [text, setText] = useState('');

  return (
    <main>
      <h1>Local-first notes</h1>
      <p>
        Writes hit the on-device database instantly (works offline). A background
        loop syncs to <code>/api/sync</code> every 10 s — open this page in a
        second window to watch changes converge.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await notes.insert({ text: text.trim(), createdAt: Date.now() });
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note" />
        <button type="submit">Add</button>
      </form>
      {loading ? (
        <p>loading…</p>
      ) : (
        <ul>
          {data
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((n) => (
              <li key={n._id}>
                {n.text}{' '}
                <button onClick={() => notes.deleteOne({ _id: n._id })} aria-label="delete">
                  ×
                </button>
              </li>
            ))}
        </ul>
      )}
    </main>
  );
}
