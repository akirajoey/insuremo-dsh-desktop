import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { textMatchesDevPathNeedle } from './scan-dev-path-needles.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requested = process.argv.slice(2).map(path => resolve(root, path))
const roots = requested.length > 0 ? requested : [join(root, 'release/win-unpacked')]
const findings = { sourceMaps: [], testPaths: [], absoluteDevPaths: [], tokenLike: [], roots: roots.map(path => relative(root, path).split('\\').join('/')) }
const binaryExtensions = new Set(['.node', '.dll', '.exe', '.pak', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.nsis', '.blockmap', '.ttf', '.woff', '.woff2', '.pdf'])
function visit(current) {
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const info = lstatSync(path)
    const relativePath = relative(root, path).split('\\').join('/')
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (/(?:^|\/)(?:test|tests|__tests__|fixtures|examples?)(?:\/|$)/u.test(relativePath)) findings.testPaths.push(relativePath)
      visit(path)
      continue
    }
    if (name.endsWith('.map')) findings.sourceMaps.push(relativePath)
    if (/(?:^|\/)(?:test|tests|__tests__|fixtures|examples?)(?:\/|$)/u.test(relativePath)) findings.testPaths.push(relativePath)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
    if (binaryExtensions.has(extension)) continue
    let bytes
    try { bytes = readFileSync(path) } catch { continue }
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    for (const needle of ['/Users/', '/opt/homebrew', 'icomposer-workbench-plan', '\\Users\\']) {
      if (textMatchesDevPathNeedle(text, needle)) findings.absoluteDevPaths.push({ path: relativePath, needle })
    }
    if (/(?:^|\s)sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9]{20,}/u.test(text)) findings.tokenLike.push(relativePath)
  }
}
for (const path of roots) if (existsSync(path)) visit(path)
const unique = values => [...new Set(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)))].map(value => { try { return JSON.parse(value) } catch { return value } })
for (const key of Object.keys(findings)) if (Array.isArray(findings[key])) findings[key] = unique(findings[key])
const result = { schemaVersion: 1, roots: findings.roots, counts: { sourceMaps: findings.sourceMaps.length, testPaths: findings.testPaths.length, absoluteDevPaths: findings.absoluteDevPaths.length, tokenLike: findings.tokenLike.length }, findings, sha256: createHash('sha256').update(JSON.stringify(findings)).digest('hex') }
writeFileSync(join(root, 'docs/evidence/e08-scan.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ output: 'docs/evidence/e08-scan.json', ...result.counts, sha256: result.sha256 }, null, 2))
if (Object.values(result.counts).some(value => value > 0)) process.exitCode = 1
