import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { TalaDB, OpenDBOptions } from 'taladb'

const TalaDBContext = createContext<TalaDB | null>(null)

export type TalaDBProviderProps = {
  children: ReactNode
} & (
  | {
      /** A TalaDB instance you opened yourself with `openDB()`. */
      db: TalaDB
      name?: never
      options?: never
      fallback?: never
    }
  | {
      /**
       * Database name — the provider owns the `openDB(name)` lifecycle:
       * it opens lazily on the client (never during SSR), provides the handle
       * once ready, and closes it on unmount. The natural form for Next.js,
       * where `openDB` cannot run during server rendering.
       */
      name: string
      /** Options forwarded to `openDB(name, options)` (e.g. inline sync config). */
      options?: OpenDBOptions
      /**
       * Rendered while the database is opening (and during SSR).
       * Defaults to `null`. Children only render once the db is ready, so
       * `useTalaDB()` never observes a missing instance.
       */
      fallback?: ReactNode
      db?: never
    }
)

/**
 * Provides a TalaDB instance to all child hooks.
 *
 * Two forms:
 *
 * **Instance form** — you own the lifecycle (plain React, React Native):
 * ```tsx
 * const db = await openDB('myapp.db')
 * <TalaDBProvider db={db}>…</TalaDBProvider>
 * ```
 *
 * **Name form** — the provider owns the lifecycle (recommended for Next.js):
 * ```tsx
 * <TalaDBProvider name="myapp.db" fallback={<Splash />}>…</TalaDBProvider>
 * ```
 * The database opens client-side only; during SSR (and while opening) the
 * `fallback` renders instead of children, so hooks always see a ready db.
 */
export function TalaDBProvider(props: TalaDBProviderProps) {
  if ('db' in props && props.db) {
    return <TalaDBContext.Provider value={props.db}>{props.children}</TalaDBContext.Provider>
  }
  return <NamedProvider {...(props as Extract<TalaDBProviderProps, { name: string }>)} />
}

function NamedProvider({
  name,
  options,
  fallback = null,
  children,
}: Extract<TalaDBProviderProps, { name: string }>) {
  const [db, setDb] = useState<TalaDB | null>(null)
  const [error, setError] = useState<unknown>(null)
  const optionsKey = JSON.stringify(options ?? null)

  useEffect(() => {
    setError(null)
    let cancelled = false
    let opened: TalaDB | null = null
    // Dynamic import so `taladb`'s runtime never loads during SSR module
    // evaluation (its Node entry pulls in the native binding, which a web
    // app's server bundle does not ship).
    import('taladb')
      .then(({ openDB }) => openDB(name, options))
      .then((instance) => {
        if (cancelled) {
          // Effect re-ran (e.g. StrictMode) before the open resolved — release
          // the orphaned handle so its worker/lock don't linger.
          void instance.close()
          return
        }
        opened = instance
        setDb(instance)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e)
      })
    return () => {
      cancelled = true
      if (opened) void opened.close()
      setDb(null)
    }
    // Use serialized option identity so equivalent inline objects do not
    // thrash the worker, while actual configuration changes reopen safely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, optionsKey])

  // Surface open failures to the nearest error boundary instead of hanging on
  // the fallback forever.
  if (error !== null) throw error

  if (db === null) return <>{fallback}</>
  return <TalaDBContext.Provider value={db}>{children}</TalaDBContext.Provider>
}

/**
 * Returns the TalaDB instance from the nearest `<TalaDBProvider>`.
 *
 * @throws If called outside of a `<TalaDBProvider>`.
 */
export function useTalaDB(): TalaDB {
  const db = useContext(TalaDBContext)
  if (db === null) {
    throw new Error('useTalaDB must be used inside <TalaDBProvider db={...}> or <TalaDBProvider name="...">')
  }
  return db
}
