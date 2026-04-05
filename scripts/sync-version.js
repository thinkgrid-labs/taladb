#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const version = rootPkg.version

const packages = [
  'packages/taladb',
  'packages/taladb-web',
  'packages/taladb-node',
  'packages/taladb-react-native',
  'examples/web-vite',
]

for (const pkg of packages) {
  const pkgPath = resolve(root, pkg, 'package.json')
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkgJson.version = version

  // Sync taladb / @taladb/* dependency references, but leave workspace:* untouched
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkgJson[depField]) continue
    for (const dep of Object.keys(pkgJson[depField])) {
      if ((dep === 'taladb' || dep.startsWith('@taladb/')) && pkgJson[depField][dep] !== 'workspace:*') {
        pkgJson[depField][dep] = `^${version}`
      }
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n')
  console.log(`✓ ${pkg} → ${version}`)
}
