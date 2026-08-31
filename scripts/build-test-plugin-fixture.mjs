/**
 * Deterministic, pure-Node builder for the reviewable test plugin fixture
 * (test/fixtures/icomposer-test-plugin) into an npm-style `.tgz`.
 *
 * The tar is USTAR with fully pinned metadata (mode 0644, uid/gid 0,
 * mtime 0, sorted `package/`-prefixed entries) and the gzip wrapper pins
 * mtime 0, so the bytes — and therefore the SHA256 — are identical on every
 * run and platform for a given fixture source. No tgz is committed and no
 * external tool (tar/sips/Pillow) is invoked; this module stays free of
 * child_process by design (pnpm resolution lives in resolve-pnpm-entry.mjs).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_SOURCE_DIR = 'test/fixtures/icomposer-test-plugin'
export const FIXTURE_PACKAGE_NAME = '@icomposer/test-plugin'

let cached

/** Build the deterministic npm-style tgz buffer from the fixture source dir. */
export function buildFixtureTar(fixtureDir = join(root, FIXTURE_SOURCE_DIR)) {
  const files = collectFiles(fixtureDir)
  if (files.length === 0) throw new Error('test plugin fixture source is empty')
  const chunks = []
  for (const { name, bytes } of files) {
    chunks.push(ustarHeader(`package/${name}`, bytes.length), bytes, pad512(bytes.length))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 })
}

/** Ensure a fixture tgz exists; regenerate per process into a temp dir by default. */
export function ensureTestPluginTgz(targetPath) {
  const path = targetPath ?? cached?.path
  if (path !== undefined && existsSync(path) && cached?.stat === statSync(path).mtimeMs) return cached
  const bytes = buildFixtureTar()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (targetPath === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-test-plugin-'))
    const file = join(dir, 'icomposer-test-plugin-0.1.0.tgz')
    writeFileSync(file, bytes)
    cached = { path: file, sha256, stat: statSync(file).mtimeMs }
    return cached
  }
  if (!isAbsolute(targetPath)) throw new Error('fixture target path must be absolute')
  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(targetPath, bytes)
  return { path: targetPath, sha256, stat: statSync(targetPath).mtimeMs }
}

function collectFiles(dir) {
  const entries = []
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name)
      if (statSync(file).isDirectory()) visit(file)
      else entries.push({ name: relative(dir, file).split('\\').join('/'), bytes: readFileSync(file) })
    }
  }
  visit(dir)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function octal(value, length) {
  const text = value.toString(8)
  return text.padStart(length - 1, '0') + '\0'
}

function pad512(size) {
  const remainder = size % 512
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder)
}

function ustarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 99), 0, 100, 'utf8')
  header.write(octal(0o644, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(0, 12), 136) // mtime pinned to epoch
  header.write('        ', 148) // checksum placeholder spaces
  header[156] = 0x30 // typeflag '0'
  header.write('ustar', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const target = process.argv[2]
  const result = ensureTestPluginTgz(target === undefined ? undefined : resolve(target))
  console.log(JSON.stringify({ path: result.path, sha256: result.sha256 }))
}
