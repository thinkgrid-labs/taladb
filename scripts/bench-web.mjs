#!/usr/bin/env node
/**
 * TalaDB browser benchmark driver.
 *
 * Serves the repo over HTTP, launches headless Chrome on
 * scripts/bench-web/index.html, and collects the results the page POSTs back.
 * No browser-automation dependency required — plain Chrome.
 *
 *   pnpm --filter @taladb/web build   # build the WASM package first
 *   node scripts/bench-web.mjs [--json]
 *
 * The page drives the @taladb/web worker (WASM + OPFS) over its message
 * protocol — the same path the `taladb` wrapper uses, so timings include the
 * full JS ↔ worker ↔ WASM round-trip.
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir, cpus, arch, platform } from 'node:os'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..')

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean)

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

const fmtMs = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : ms < 100 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`)
const fmtOps = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0))

async function main() {
  const chrome = CHROME_CANDIDATES.find((c) => existsSync(c))
  if (!chrome) throw new Error('Chrome not found — set CHROME_BIN')

  let resolveResult, rejectResult
  const resultPromise = new Promise((res, rej) => { resolveResult = res; rejectResult = rej })

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/__bench/')) {
      let body = ''
      for await (const chunk of req) body += chunk
      res.writeHead(204).end()
      const kind = req.url.slice('/__bench/'.length)
      const payload = JSON.parse(body || '{}')
      if (kind === 'progress') console.error(payload.msg)
      else if (kind === 'result') resolveResult(payload)
      else if (kind === 'error') rejectResult(new Error(payload.error))
      return
    }
    // Static files, repo-rooted. Path traversal is blocked by normalize+prefix
    // check; this server only ever binds 127.0.0.1 and lives for one run.
    const path = normalize(join(root, decodeURIComponent((req.url ?? '/').split('?')[0])))
    if (!path.startsWith(root)) return void res.writeHead(403).end()
    try {
      const data = await readFile(path)
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const quick = process.argv.includes('--quick') ? '?quick=1' : ''
  const url = `http://127.0.0.1:${port}/scripts/bench-web/index.html${quick}`

  const profile = await mkdtemp(join(tmpdir(), 'taladb-bench-chrome-'))
  console.error(`launching headless Chrome on ${url}`)
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: 'ignore' })

  const timeout = setTimeout(() => rejectResult(new Error('benchmark timed out after 15 min')), 15 * 60 * 1000)

  try {
    const { ua, opfs, rows } = await resultPromise
    clearTimeout(timeout)

    const cpu = cpus()[0]?.model ?? 'unknown CPU'
    const chromeVer = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '?'
    console.log(`\nTalaDB browser bench · Chrome ${chromeVer} (headless) · OPFS ${opfs ? 'active' : 'UNAVAILABLE (in-memory fallback!)'} · ${cpu} · ${platform()} ${arch()} · ${new Date().toISOString().slice(0, 10)}\n`)
    for (const r of rows) {
      if (r.section) {
        console.log(`\n### ${r.section}\n`)
        console.log('| Operation | Detail | Result |')
        console.log('|---|---|---|')
      } else {
        let value
        if (r.unit === 'opsPerSec') value = `${fmtOps(1000 / r.median)} ops/s`
        else if (r.unit === 'docsPerSec') value = `${fmtOps(r.batch * (1000 / r.median))} docs/s`
        else if (r.unit === 'ingest') value = `${fmtOps(r.n / (r.median / 1000))} docs/s`
        else value = fmtMs(r.median)
        console.log(`| ${r.name} | ${r.detail} | **${value}** |`)
      }
    }
    if (process.argv.includes('--json')) {
      await writeFile('bench-web-results.json', JSON.stringify({ ua, rows }, null, 2))
      console.error('\nwrote bench-web-results.json')
    }
  } finally {
    proc.kill('SIGKILL')
    server.close()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
