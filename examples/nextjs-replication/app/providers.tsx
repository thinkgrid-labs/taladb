'use client';

import { TalaDBProvider, ReplicationProvider } from '@taladb/react';

// The origin authorizes a session token and returns that user's slice. The demo
// backend accepts any bearer token and maps everyone to one shared scope, so the
// token here is a placeholder — swap in your real session token.
function getAuth() {
  return { Authorization: 'Bearer demo-token' };
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TalaDBProvider name="replication-example.db" fallback={<p>opening local database…</p>}>
      <ReplicationProvider
        endpoint="/api/sync"
        getAuth={getAuth}
        // Default background refresh for every useQuery below (override per hook).
        pollMs={15_000}
        // Warm these slices into the local replica on first run, in the
        // background (idle-deferred), so their pages read local immediately.
        prefetch={['products', 'categories']}
        prefetchMode="once"
      >
        {children}
      </ReplicationProvider>
    </TalaDBProvider>
  );
}
