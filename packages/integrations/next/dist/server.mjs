// src/server.ts
function createSyncHandlers(options) {
  const { store } = options;
  const authorize = options.authorize ?? (() => "default");
  async function resolveScope(req) {
    const scope = await authorize(req);
    return scope ?? null;
  }
  return {
    async POST(req) {
      const scope = await resolveScope(req);
      if (scope === null) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      let records;
      try {
        records = JSON.parse(body === "" ? "[]" : body);
      } catch {
        return new Response("invalid changeset: not JSON", { status: 400 });
      }
      if (!Array.isArray(records)) {
        return new Response("invalid changeset: expected a JSON array", { status: 400 });
      }
      for (const r of records) {
        const rec = r;
        if (typeof rec !== "object" || rec === null || typeof rec.collection !== "string" || typeof rec.id !== "string" || typeof rec.changed_at !== "number") {
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
      if (!Number.isFinite(since) || since < 0) {
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
        const existing = docs.get(key);
        if (!existing || change.changed_at > existing.changed_at) docs.set(key, change);
      }
    },
    async pull(sinceMs, scope) {
      const docs = scopes.get(scope);
      if (!docs) return "[]";
      return JSON.stringify([...docs.values()].filter((c) => c.changed_at > sinceMs));
    }
  };
}
function taladbSyncStore(db, collectionName = "sync_changes") {
  const col = db.collection(collectionName);
  const indexed = (async () => {
    await col.createIndex("key").catch(() => {
    });
    await col.createIndex("changed_at").catch(() => {
    });
  })();
  return {
    async push(changeset, scope) {
      await indexed;
      for (const change of JSON.parse(changeset)) {
        const key = `${change.collection}::${change.id}`;
        const serialized = JSON.stringify(change);
        const existing = await col.findOne({ scope, key });
        if (!existing) {
          await col.insert({ scope, key, changed_at: change.changed_at, change: serialized });
        } else if (change.changed_at > existing.changed_at) {
          await col.updateOne(
            { scope, key },
            { $set: { changed_at: change.changed_at, change: serialized } }
          );
        }
      }
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
