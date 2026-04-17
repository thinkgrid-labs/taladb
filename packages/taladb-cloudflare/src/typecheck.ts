// Type-only smoke test — compiled by tsc --noEmit in CI, not published.
// Verifies that the exported types are coherent with @cloudflare/workers-types.
import type { CloudflareDB } from './index';

// CloudflareDB surface
declare const db: CloudflareDB;
const _col = db.collection<{ name: string }>('users');
const _flush: () => Promise<void> = db.flush.bind(db);
const _compact: () => Promise<void> = db.compact.bind(db);
const _close: () => Promise<void> = db.close.bind(db);

// Collection operations
const _insert: (doc: { name: string }) => Promise<string> = _col.insert.bind(_col);
const _findAll: Promise<{ name: string }[]> = _col.find();

// openDurableDB accepts DurableObjectStorage
declare const storage: DurableObjectStorage;
import type { openDurableDB } from './index';
declare const _open: typeof openDurableDB;
const _dbPromise: Promise<CloudflareDB> = _open(storage);

void _col; void _flush; void _compact; void _close;
void _insert; void _findAll; void _dbPromise;
