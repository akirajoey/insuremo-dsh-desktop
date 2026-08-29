import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CompatibilityManifest, SnapshotFile, UpgradeSnapshotManifest } from './contracts.ts'

const SNAPSHOT_ROOTS = [
  'harness/profiles',
  'harness/sessions',
  'harness/settings.yaml',
  'desktop-state/workbench-install.json',
  'desktop-state/auth-schema.json',
]
const SECRET_SEGMENTS = new Set(['token-store', 'tokens', '.tokens', 'credentials', 'secrets'])
const SECRET_FILE = /(?:auth|token|credential|secret|refresh)[^/\\]*$/iu

function isSecretPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.at(-1)?.toLowerCase() === 'auth-schema.json') return false
  return parts.some(part => SECRET_SEGMENTS.has(part.toLowerCase())) || SECRET_FILE.test(parts.at(-1) ?? '')
}
function hashBytes(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function hashText(value: string): string { return createHash('sha256').update(value).digest('hex') }
function ensureInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(candidate)
  const rel = relative(resolvedRoot, resolved)
  if (rel === '..' || rel.startsWith(`..${requireSep()}`) || isAbsolute(rel)) throw new Error('snapshot path escapes userData')
  return resolved
}
function requireSep(): string { return process.platform === 'win32' ? '\\' : '/' }
function chmodPrivate(path: string): void { try { chmodSync(path, 0o700) } catch { /* Windows ACLs are handled by the containing userData. */ } }

function walk(root: string, current = root): SnapshotFile[] {
  const files: SnapshotFile[] = []
  if (!existsSync(current)) return files
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const rel = relative(root, path).split('\\').join('/')
    if (isSecretPath(rel)) continue
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      files.push({ path: rel, kind: 'symlink', target, size: Buffer.byteLength(target), sha256: hashText(target) })
    } else if (info.isDirectory()) files.push(...walk(root, path))
    else files.push({ path: rel, kind: 'file', size: statSync(path).size, sha256: hashBytes(path) })
  }
  return files
}

function copyTree(source: string, destination: string, userData: string): void {
  if (!existsSync(source) || isSecretPath(relative(userData, source))) return
  const info = lstatSync(source)
  if (info.isSymbolicLink()) {
    const target = readlinkSync(source)
    if (isAbsolute(target)) throw new Error(`snapshot refuses absolute symlink: ${relative(userData, source)}`)
    ensureInside(userData, resolve(dirname(source), target))
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(target, destination)
    return
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name), userData)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

export interface CreateSnapshotOptions {
  userData: string
  compatibility: CompatibilityManifest
  snapshotId?: string
  snapshotsRoot?: string
}

/** Create a private, hash-indexed upgrade snapshot without token material. */
export function createUpgradeSnapshot(options: CreateSnapshotOptions): UpgradeSnapshotManifest {
  const snapshotId = options.snapshotId ?? randomUUID()
  const root = options.snapshotsRoot ?? join(options.userData, 'desktop-state/upgrades')
  const destination = ensureInside(options.userData, join(root, snapshotId, 'snapshot'))
  mkdirSync(destination, { recursive: true })
  chmodPrivate(destination)
  const copiedRoots: string[] = []
  for (const path of SNAPSHOT_ROOTS) {
    const source = ensureInside(options.userData, join(options.userData, path))
    if (!existsSync(source) || isSecretPath(path)) continue
    copyTree(source, join(destination, path), options.userData)
    copiedRoots.push(path)
  }
  const files = walk(destination).sort((a, b) => a.path.localeCompare(b.path))
  const partial: Omit<UpgradeSnapshotManifest, 'sha256'> = {
    schemaVersion: 1,
    snapshotId,
    createdAt: new Date().toISOString(),
    compatibility: {
      desktop: options.compatibility.desktop,
      dsh: options.compatibility.dsh,
      workbench: options.compatibility.workbench,
      profile: options.compatibility.profile,
      session: options.compatibility.session,
    },
    roots: copiedRoots,
    authState: 'schema-only-not-token-store',
    files,
  }
  const digest = hashText(JSON.stringify(partial))
  const manifest = { ...partial, sha256: digest } as UpgradeSnapshotManifest
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  chmodPrivate(join(root, snapshotId))
  return manifest
}

export function verifyUpgradeSnapshot(snapshotPath: string): UpgradeSnapshotManifest {
  const manifestPath = join(snapshotPath, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as UpgradeSnapshotManifest
  if (manifest.schemaVersion !== 1 || manifest.authState !== 'schema-only-not-token-store') throw new Error('invalid upgrade snapshot schema')
  const { sha256, ...withoutDigest } = manifest
  if (hashText(JSON.stringify(withoutDigest)) !== sha256) throw new Error('upgrade snapshot manifest hash mismatch')
  for (const entry of manifest.files) {
    if (isSecretPath(entry.path)) throw new Error(`upgrade snapshot contains secret path: ${entry.path}`)
    const path = ensureInside(snapshotPath, join(snapshotPath, entry.path))
    if (!existsSync(path)) throw new Error(`upgrade snapshot file missing: ${entry.path}`)
    if (entry.kind === 'symlink') {
      if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== entry.target) throw new Error(`upgrade snapshot symlink mismatch: ${entry.path}`)
      ensureInside(snapshotPath, resolve(dirname(path), entry.target ?? ''))
    } else if (statSync(path).size !== entry.size || hashBytes(path) !== entry.sha256) throw new Error(`upgrade snapshot hash mismatch: ${entry.path}`)
  }
  return manifest
}

/** Restore only the allowlisted snapshot roots; never touches token stores. */
export function restoreUpgradeSnapshot(snapshotPath: string, userData: string): UpgradeSnapshotManifest {
  const manifest = verifyUpgradeSnapshot(snapshotPath)
  for (const path of manifest.roots) {
    if (isSecretPath(path)) continue
    const source = ensureInside(snapshotPath, join(snapshotPath, path))
    const destination = ensureInside(userData, join(userData, path))
    if (existsSync(source)) cpSync(source, destination, { recursive: true, force: true, dereference: false })
  }
  return manifest
}

export { SNAPSHOT_ROOTS, SECRET_SEGMENTS }
