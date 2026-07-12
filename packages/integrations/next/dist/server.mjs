// src/server.ts
function createSyncHandlers(options) {
  const { store } = options;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxRecords = options.maxRecords ?? 1e4;
  const authorize = options.authorize ?? (() => "default");
  async function resolveScope(req) {
    const scope = await authorize(req);
    return scope ?? null;
  }
  return {
    async POST(req) {
      const scope = await resolveScope(req);
      if (scope === null) return new Response("unauthorized", { status: 401 });
      const declaredLength = Number(req.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        return new Response("changeset too large", { status: 413 });
      }
      const body = await req.text();
      if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
        return new Response("changeset too large", { status: 413 });
      }
      let records;
      try {
        records = JSON.parse(body === "" ? "[]" : body);
      } catch {
        return new Response("invalid changeset: not JSON", { status: 400 });
      }
      if (!Array.isArray(records)) {
        return new Response("invalid changeset: expected a JSON array", { status: 400 });
      }
      if (records.length > maxRecords) {
        return new Response("too many change records", { status: 413 });
      }
      for (const r of records) {
        const rec = r;
        if (typeof rec !== "object" || rec === null || typeof rec.collection !== "string" || typeof rec.id !== "string" || typeof rec.changed_at !== "number" || !Number.isSafeInteger(rec.changed_at) || rec.changed_at < 0) {
          return new Response("invalid changeset: malformed change record", { status: 400 });
        }
      }
      if (records.length > 0) {
        await store.push(JSON.stringify(records), scope);
      }
      return new Response(null, { status: 204 });
    },
    async GET(req) {
      const scope = await resolveScope(req);
      if (scope === null) return new Response("unauthorized", { status: 401 });
      const sinceRaw = new URL(req.url).searchParams.get("since") ?? "0";
      const since = Number(sinceRaw);
      if (!Number.isSafeInteger(since) || since < 0) {
        return new Response("invalid since parameter", { status: 400 });
      }
      const changeset = await store.pull(since, scope);
      return new Response(changeset, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  };
}
function memorySyncStore() {
  const scopes = /* @__PURE__ */ new Map();
  return {
    async push(changeset, scope) {
      let docs = scopes.get(scope);
      if (!docs) {
        docs = /* @__PURE__ */ new Map();
        scopes.set(scope, docs);
      }
      for (const change of JSON.parse(changeset)) {
        const key = `${change.collection}::${change.id}`;
        const existing = docs.get(key) ?? [];
        const latest = existing[0]?.changed_at;
        if (latest === void 0 || change.changed_at > latest) docs.set(key, [change]);
        else if (change.changed_at === latest) {
          const serialized = JSON.stringify(change);
          if (!existing.some((candidate) => JSON.stringify(candidate) === serialized)) {
            existing.push(change);
          }
        }
      }
    },
    async pull(sinceMs, scope) {
      const docs = scopes.get(scope);
      if (!docs) return "[]";
      return JSON.stringify(
        [...docs.values()].flat().filter((c) => c.changed_at > sinceMs)
      );
    }
  };
}
var taladbStoreQueues = /* @__PURE__ */ new WeakMap();
function taladbSyncStore(db, collectionName = "sync_changes") {
  const col = db.collection(collectionName);
  const indexed = (async () => {
    await col.createIndex("doc_key").catch(() => {
    });
    await col.createIndex("changed_at").catch(() => {
    });
  })();
  let queues = taladbStoreQueues.get(db);
  if (!queues) {
    queues = /* @__PURE__ */ new Map();
    taladbStoreQueues.set(db, queues);
  }
  return {
    async push(changeset, scope) {
      const run = async () => {
        await indexed;
        for (const change of JSON.parse(changeset)) {
          const docKey = `${change.collection}::${change.id}`;
          const serialized = JSON.stringify(change);
          const existing = await col.find({ scope, doc_key: docKey });
          const latest = existing.reduce((n, row) => Math.max(n, row.changed_at), -Infinity);
          if (change.changed_at > latest) {
            if (existing.length > 0) await col.deleteMany({ scope, doc_key: docKey });
            await col.insert({ scope, doc_key: docKey, changed_at: change.changed_at, change: serialized });
          } else if (change.changed_at === latest && !existing.some((row) => row.change === serialized)) {
            await col.insert({ scope, doc_key: docKey, changed_at: change.changed_at, change: serialized });
          }
        }
      };
      const previous = queues.get(collectionName) ?? Promise.resolve();
      const operation = previous.then(run, run);
      queues.set(collectionName, operation.catch(() => {
      }));
      await operation;
    },
    async pull(sinceMs, scope) {
      await indexed;
      const rows = await col.find({ scope, changed_at: { $gt: sinceMs } });
      return `[${rows.map((r) => r.change).join(",")}]`;
    }
  };
}
export {
  createSyncHandlers,
  memorySyncStore,
  taladbSyncStore
};
