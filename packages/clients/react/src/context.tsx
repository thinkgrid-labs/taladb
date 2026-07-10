import { createContext, useContext, type ReactNode } from 'react'
import type { TalaDB } from 'taladb'

const TalaDBContext = createContext<TalaDB | null>(null)

export interface TalaDBProviderProps {
  /** The TalaDB instance returned by `openDB()`. */
  db: TalaDB
  children: ReactNode
}

/**
 * Provides a TalaDB instance to all child hooks.
 *
 * @example
 * const db = await openDB('myapp.db')
 *
 * function App() {
 *   return (
 *     <TalaDBProvider db={db}>
 *       <MyComponent />
 *     </TalaDBProvider>
 *   )
 * }
 */
export function TalaDBProvider({ db, children }: TalaDBProviderProps) {
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
    throw new Error('useTalaDB must be used inside <TalaDBProvider db={...}>')
  }
  return db
}
