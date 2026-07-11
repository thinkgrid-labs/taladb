'use client';

import { TalaDBProvider } from '@taladb/react';
import { SyncProvider } from '@taladb/next/client';

// Demo identity: a random per-browser token; the server uses it as the sync
// scope. Replace with your real auth token.
function getToken(): string {
  let t = localStorage.getItem('demo-token');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('demo-token', t);
  }
  return t;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TalaDBProvider name="notes-example.db" fallback={<p>opening local database…</p>}>
      <SyncProvider
        endpoint="/api/sync"
        intervalMs={10_000}
        headers={() => ({ Authorization: `Bearer ${getToken()}` })}
        onError={(e) => console.warn('sync skipped:', e)}
      >
        {children}
      </SyncProvider>
    </TalaDBProvider>
  );
}
