/**
 * Name-based <TalaDBProvider name="..."> — the provider owns the openDB
 * lifecycle: fallback until open, children with a ready db afterwards,
 * close on unmount (including a StrictMode-style cancelled open).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { TalaDB } from 'taladb'
import { TalaDBProvider, useTalaDB } from '../../src/context'

const closeSpy = vi.fn()
let resolveOpen: ((db: TalaDB) => void) | undefined
let openCalls: Array<{ name: string; options: unknown }> = []

vi.mock('taladb', () => ({
  openDB: (name: string, options: unknown) => {
    openCalls.push({ name, options })
    return new Promise<TalaDB>((res) => {
      resolveOpen = res
    })
  },
}))

const makeDb = (): TalaDB =>
  ({ close: closeSpy, collection: vi.fn() }) as unknown as TalaDB

function Probe() {
  const db = useTalaDB()
  return <div data-testid="ready">{db ? 'db-ready' : 'no-db'}</div>
}

beforeEach(() => {
  cleanup()
  closeSpy.mockClear()
  resolveOpen = undefined
  openCalls = []
})

describe('<TalaDBProvider name="...">', () => {
  it('renders the fallback while opening, then children with a ready db', async () => {
    render(
      <TalaDBProvider name="app.db" fallback={<div data-testid="splash">loading</div>}>
        <Probe />
      </TalaDBProvider>,
    )

    expect(screen.getByTestId('splash')).toBeDefined()
    expect(screen.queryByTestId('ready')).toBeNull()
    // the dynamic import('taladb') resolves on a microtask
    await waitFor(() => expect(openCalls).toEqual([{ name: 'app.db', options: undefined }]))

    resolveOpen!(makeDb())
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('db-ready'))
    expect(screen.queryByTestId('splash')).toBeNull()
  })

  it('forwards options to openDB', async () => {
    const options = { config: { sync: { enabled: false } } }
    render(
      <TalaDBProvider name="app.db" options={options}>
        <Probe />
      </TalaDBProvider>,
    )
    await waitFor(() => expect(openCalls[0]).toEqual({ name: 'app.db', options }))
  })

  it('closes the db on unmount', async () => {
    const { unmount } = render(
      <TalaDBProvider name="app.db">
        <Probe />
      </TalaDBProvider>,
    )
    await waitFor(() => expect(resolveOpen).toBeDefined())
    resolveOpen!(makeDb())
    await waitFor(() => expect(screen.getByTestId('ready')).toBeDefined())

    unmount()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('closes an orphaned handle when the open resolves after unmount', async () => {
    const { unmount } = render(
      <TalaDBProvider name="app.db">
        <Probe />
      </TalaDBProvider>,
    )
    await waitFor(() => expect(resolveOpen).toBeDefined())
    unmount() // cancelled before the open resolves

    resolveOpen!(makeDb())
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1))
  })

  it('db-prop form still works unchanged', () => {
    render(
      <TalaDBProvider db={makeDb()}>
        <Probe />
      </TalaDBProvider>,
    )
    expect(screen.getByTestId('ready').textContent).toBe('db-ready')
  })
})
