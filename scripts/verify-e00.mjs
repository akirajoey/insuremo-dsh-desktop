import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const adr = await readFile(resolve(root, 'docs/decisions/ADR-0001-local-access-boundary.md'), 'utf8')
const requiredPins = {
  electron: '43.4.0',
  react: '18.3.1',
}

if (packageJson.packageManager !== 'pnpm@11.7.0') throw new Error('pnpm pin is not exact')
for (const section of [packageJson.dependencies, packageJson.devDependencies]) {
  for (const [name, version] of Object.entries(section)) {
    if (/^[~^]/.test(version)) throw new Error(`${name} is not exact: ${version}`)
  }
}
for (const [name, version] of Object.entries(requiredPins)) {
  const actual = packageJson.dependencies[name] ?? packageJson.devDependencies[name]
  if (actual !== version) throw new Error(`${name} pin mismatch: ${actual}`)
}
for (const phrase of ['same-user local trust', '127.0.0.1', 'random port is not an', 'Strong-auth alternative']) {
  if (!adr.includes(phrase)) throw new Error(`ADR missing: ${phrase}`)
}
if (/\/Users\/|[A-Z]:\\/.test(adr)) throw new Error('ADR contains a machine-specific absolute path')
console.log('E00 contract: PASS')
