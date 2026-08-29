import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export interface RuntimeResourceFile {
  path: string
  kind: 'file' | 'symlink'
  size: number
  sha256: string
  target?: string
}

export interface RuntimeResourceManifest {
  schemaVersion: 1
  runtimeVersion: string
  nodeVersion: string
  runtimeArch: string
  files: RuntimeResourceFile[]
  workbench: { path: string; sha256: string }
}

export interface RuntimeResourceLayout {
  root: string
  harnessRoot: string
  nodePath: string
  pnpmEntry: string
  workbenchTgz: string
  workbenchSha256: string
  supervisorPath?: string
}

export const REQUIRED_RUNTIME_VERSION = '0.1.0-rc.7'
export const REQUIRED_NODE_VERSION = '24.9.0'

export function packagedResourceRoot(): string {
  if (!app.isPackaged) throw new Error('packaged runtime resources requested in development')
  return join(process.resourcesPath, 'dsh-runtime')
}

/**
 * Verify every packaged runtime file before allowing a packaged boot. Paths
 * are manifest-relative and traversal is rejected; this protects the
 * bundled Node/pnpm/runtime graph/workbench provenance contract.
 */
export function verifyPackagedRuntime(): RuntimeResourceLayout {
  const root = packagedResourceRoot()
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('packaged runtime manifest missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeResourceManifest
  if (manifest.schemaVersion !== 1) throw new Error('unsupported packaged runtime manifest')
  if (manifest.runtimeVersion !== REQUIRED_RUNTIME_VERSION) throw new Error('packaged runtime pin mismatch')
  if (manifest.nodeVersion !== REQUIRED_NODE_VERSION) throw new Error('packaged Node version mismatch')
  if (manifest.runtimeArch !== process.arch) throw new Error('packaged runtime architecture mismatch')
  for (const entry of manifest.files) {
    const file = safeResourcePath(root, entry.path)
    if (!existsSync(file)) throw new Error(`packaged runtime file missing: ${entry.path}`)
    if (entry.kind === 'symlink') {
      const link = lstatSync(file)
      const target = readlinkSync(file)
      const targetPath = resolve(dirname(file), target)
      const targetRelative = relative(root, targetPath)
      if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) throw new Error(`packaged runtime symlink escapes root: ${entry.path}`)
      if (!link.isSymbolicLink() || target !== entry.target || entry.sha256 !== hashText(target)) {
        throw new Error(`packaged runtime symlink mismatch: ${entry.path}`)
      }
      continue
    }
    const stat = statSync(file)
    if (!stat.isFile() || stat.size !== entry.size) throw new Error(`packaged runtime size mismatch: ${entry.path}`)
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (sha256 !== entry.sha256) throw new Error(`packaged runtime hash mismatch: ${entry.path}`)
  }
  const workbenchTgz = safeResourcePath(root, manifest.workbench.path)
  if (!existsSync(workbenchTgz)) throw new Error('packaged Workbench artifact missing')
  const actualWorkbenchSha = createHash('sha256').update(readFileSync(workbenchTgz)).digest('hex')
  if (actualWorkbenchSha !== manifest.workbench.sha256) throw new Error('packaged Workbench hash mismatch')
  const arch = `${process.platform}-${process.arch}`
  const nodePath = join(root, 'node', arch, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const pnpmEntry = join(root, 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(nodePath) || !existsSync(pnpmEntry)) throw new Error(`packaged runtime executable missing for ${arch}`)
  const supervisorPath = process.platform === 'win32'
    ? join(root, 'supervisor', 'runtime-supervisor.exe')
    : undefined
  if (supervisorPath !== undefined && !existsSync(supervisorPath)) throw new Error('packaged Windows runtime supervisor missing')
  return {
    root,
    harnessRoot: join(root, 'harness'),
    nodePath,
    pnpmEntry,
    workbenchTgz,
    workbenchSha256: manifest.workbench.sha256,
    supervisorPath,
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeResourcePath(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) throw new Error(`invalid packaged resource path: ${relativePath}`)
  const canonical = relativePath.replaceAll('\\', '/')
  const segments = canonical.split('/')
  if (canonical.startsWith('/') || /^[A-Za-z]:/u.test(canonical) || segments.some(segment => segment === '..')) {
    throw new Error(`invalid packaged resource path: ${relativePath}`)
  }
  const normalized = normalize(canonical)
  const resolved = join(root, normalized)
  const escaped = relative(root, resolved)
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error(`invalid packaged resource path: ${relativePath}`)
  return resolved
}
