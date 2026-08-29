import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url)
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs', '.css', '.html'])
const ignored = new Set(['node_modules', 'out', 'release', 'packaging', '.git'])
const violations = []

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(path)
      continue
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (!sourceExtensions.has(extension)) continue
    const lines = (await readFile(path, 'utf8')).split('\n').length
    if (lines > 500) violations.push(`${relative(root.pathname, path)}: ${lines} lines`)
  }
}

await visit(root.pathname)
if (violations.length > 0) {
  console.error(`Files exceed the 500-line policy:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Line-count policy: PASS (all source/test files <= 500 lines)')
}
