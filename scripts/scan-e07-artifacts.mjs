import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = process.argv.slice(2).map(path => resolve(root, path))
if (scanRoots.length === 0) scanRoots.push(join(root, 'release/mac-arm64-signed'), join(root, 'release/mac-arm64'), join(root, 'release/mac'))
const findings = { sourceMaps: [], testPaths: [], absoluteDevPaths: [], tokenLike: [], roots: scanRoots.map(path => relative(root, path).split('\\').join('/')) }
const binaryExtensions = new Set(['.node', '.dylib', '.dll', '.exe', '.pak', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.icns', '.zip', '.dmg', '.blockmap', '.ttf', '.woff', '.woff2', '.pdf'])

function visit(current, rootPath) {
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const link = lstatSync(path)
    const relativePath = relative(root, path).split('\\').join('/')
    if (link.isSymbolicLink()) continue
    if (link.isDirectory()) {
      if (/(?:^|\/)(?:test|tests|__tests__|fixtures|examples?)(?:\/|$)/u.test(relativePath)) findings.testPaths.push(relativePath)
      visit(path, rootPath)
      continue
    }
    if (name.endsWith('.map')) findings.sourceMaps.push(relativePath)
    if (/(?:^|\/)(?:test|tests|__tests__|fixtures|examples?)(?:\/|$)/u.test(relativePath)) findings.testPaths.push(relativePath)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
    if (binaryExtensions.has(extension)) continue
    let content
    try { content = readFileSync(path) } catch { continue }
    if (content.includes(0)) continue
    const text = content.toString('utf8')
    for (const needle of ['/Users/junjie.zhang', '/opt/homebrew', 'icomposer-workbench-plan']) {
      if (text.includes(needle)) findings.absoluteDevPaths.push({ path: relativePath, needle })
    }
    if (/(?:^|\s)sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9]{20,}/u.test(text)) findings.tokenLike.push(relativePath)
  }
}

for (const path of scanRoots) if (existsSync(path)) visit(path, path)
for (const key of Object.keys(findings)) if (Array.isArray(findings[key])) findings[key] = [...new Set(findings[key].map(value => typeof value === 'string' ? value : JSON.stringify(value)))].map(value => { try { return JSON.parse(value) } catch { return value } })
const result = {
  schemaVersion: 1,
  roots: findings.roots,
  counts: { sourceMaps: findings.sourceMaps.length, testPaths: findings.testPaths.length, absoluteDevPaths: findings.absoluteDevPaths.length, tokenLike: findings.tokenLike.length },
  findings,
  sha256: createHash('sha256').update(JSON.stringify(findings)).digest('hex'),
}
const output = join(root, 'docs/evidence/e07-scan.json')
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ output: 'docs/evidence/e07-scan.json', ...result.counts, sha256: result.sha256 }, null, 2))
if (result.counts.sourceMaps || result.counts.testPaths || result.counts.absoluteDevPaths || result.counts.tokenLike) process.exitCode = 1
