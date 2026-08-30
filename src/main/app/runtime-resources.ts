import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export type RuntimeNodeMode = 'bundled' | 'electron-run-as-node'
export type RuntimeSource = 'embedded' | 'external'
export type PackagedVariant = 'full' | 'thin'

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
  nodeMode?: RuntimeNodeMode
  distribution?: 'full-runtime'
  files: RuntimeResourceFile[]
  workbench: { path: string; sha256: string }
}

export interface RuntimeResourceLayout {
  root: string
  harnessRoot: string
  nodePath: string
  pnpmEntry: string
  nodeMode: RuntimeNodeMode
  workbenchTgz: string
  workbenchSha256: string
  source: RuntimeSource
  variant: PackagedVariant
  supervisorPath?: string
}

export interface RuntimeSourceConfig {
  schemaVersion: 1
  root: string
  manifestSha256: string
}

export interface RuntimeSourceStatus {
  variant: PackagedVariant
  source: RuntimeSource | 'unavailable'
  rootName: string | null
  error: string | null
}

export const REQUIRED_RUNTIME_VERSION = '0.1.0-rc.7'
export const REQUIRED_NODE_VERSION = '24.9.0'
export const REQUIRED_ELECTRON_NODE_VERSION = '24.18.1'

export function packagedResourceRoot(): string {
  if (!app.isPackaged) throw new Error('packaged runtime resources requested in development')
  return join(process.resourcesPath, 'dsh-runtime')
}

export function readPackagedVariant(): PackagedVariant {
  const markerPath = join(app.getAppPath(), 'build/variant-marker.json')
  if (!existsSync(markerPath)) return 'full'
  let marker: unknown
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    throw new Error('packaged variant marker is invalid')
  }
  const variant = (marker as { variant?: unknown })?.variant
  if (variant !== 'full' && variant !== 'thin') throw new Error('unsupported packaged variant')
  return variant
}

/** Resolve the explicit runtime root CLI flag without exposing its value. */
export function runtimeRootFromArgs(args: readonly string[]): string | undefined {
  let value: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('--runtime-root=')) {
      if (value !== undefined) throw new Error('runtime root was specified more than once')
      value = arg.slice('--runtime-root='.length)
    } else if (arg === '--runtime-root') {
      if (value !== undefined) throw new Error('runtime root was specified more than once')
      const next = args[index + 1]
      if (next === undefined || next === '') throw new Error('runtime root argument is missing')
      value = next
      index += 1
    }
  }
  return value
}

export function readRuntimeSourceConfig(userData: string): RuntimeSourceConfig | undefined {
  const path = join(userData, 'desktop-state/runtime-source.json')
  if (!existsSync(path)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('runtime source configuration is invalid')
  }
  const config = value as Partial<RuntimeSourceConfig>
  if (config.schemaVersion !== 1 || typeof config.root !== 'string' || !/^[a-f0-9]{64}$/u.test(config.manifestSha256 ?? '')) {
    throw new Error('runtime source configuration is invalid')
  }
  return config as RuntimeSourceConfig
}

/** Select CLI, environment, or persisted runtime source in that order. */
export function resolveExternalRuntimeRoot(
  userData: string,
  args: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): { root: string; manifestSha256?: string } {
  const cliRoot = runtimeRootFromArgs(args)
  const envRoot = environment.DSH_DESKTOP_RUNTIME_ROOT
  const persisted = cliRoot === undefined && (envRoot === undefined || envRoot === '')
    ? readRuntimeSourceConfig(userData)
    : undefined
  const root = cliRoot ?? (envRoot === undefined || envRoot === '' ? persisted?.root : envRoot)
  if (root === undefined || root === '') throw new Error('no external runtime configured; choose a runtime directory or set DSH_DESKTOP_RUNTIME_ROOT')
  const canonical = canonicalRuntimeRoot(root)
  if (persisted !== undefined && cliRoot === undefined && (envRoot === undefined || envRoot === '')) {
    return { root: canonical, manifestSha256: persisted.manifestSha256 }
  }
  return { root: canonical }
}

/** Persist only the canonical root and its manifest digest; no credentials are stored. */
export function writeRuntimeSourceConfig(userData: string, root: string): RuntimeSourceConfig {
  const canonical = canonicalRuntimeRoot(root)
  const manifestSha256 = digestFile(join(canonical, 'manifest.json'))
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) throw new Error('external runtime manifest digest is invalid')
  const config: RuntimeSourceConfig = { schemaVersion: 1, root: canonical, manifestSha256 }
  const directory = join(userData, 'desktop-state')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'runtime-source.json')
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
  return config
}

/** Verify the embedded Full runtime or the selected Thin external runtime. */
export function verifyPackagedRuntime(): RuntimeResourceLayout {
  const variant = readPackagedVariant()
  if (variant === 'thin') {
    const selection = resolveExternalRuntimeRoot(app.getPath('userData'))
    return verifyRuntimeRoot(selection.root, 'external', variant, selection.manifestSha256)
  }
  return verifyRuntimeRoot(packagedResourceRoot(), 'embedded', variant)
}

/** Verify an on-disk runtime using the same manifest contract for Full and Thin. */
export function verifyRuntimeRoot(
  root: string,
  source: RuntimeSource,
  variant: PackagedVariant = source === 'external' ? 'thin' : 'full',
  expectedManifestSha256?: string,
): RuntimeResourceLayout {
  const canonicalRoot = canonicalRuntimeRoot(root)
  const manifestPath = join(canonicalRoot, 'manifest.json')
  if (expectedManifestSha256 !== undefined && digestFile(manifestPath) !== expectedManifestSha256) {
    throw new Error('external runtime manifest digest mismatch')
  }
  const manifest = readManifest(manifestPath)
  if (manifest.schemaVersion !== 1) throw new Error('unsupported packaged runtime manifest')
  if (source === 'external' && manifest.distribution !== 'full-runtime') throw new Error('external runtime distribution marker mismatch')
  if (manifest.runtimeVersion !== REQUIRED_RUNTIME_VERSION) throw new Error('packaged runtime pin mismatch')
  const nodeMode = manifest.nodeMode ?? 'bundled'
  if (nodeMode !== 'bundled' && nodeMode !== 'electron-run-as-node') throw new Error('unsupported packaged Node mode')
  const expectedNodeVersion = nodeMode === 'electron-run-as-node' ? REQUIRED_ELECTRON_NODE_VERSION : REQUIRED_NODE_VERSION
  if (manifest.nodeVersion !== expectedNodeVersion) throw new Error('packaged Node version mismatch')
  if (manifest.runtimeArch !== process.arch) throw new Error('packaged runtime architecture mismatch')
  if (nodeMode === 'electron-run-as-node' && process.platform !== 'darwin') throw new Error('Electron run-as-Node mode is Darwin-only')
  if (nodeMode === 'electron-run-as-node' && process.versions.node !== REQUIRED_ELECTRON_NODE_VERSION) throw new Error('Electron embedded Node version mismatch')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('packaged runtime manifest has no files')
  const seen = new Set<string>()
  for (const entry of manifest.files) {
    if (!isRuntimeFileEntry(entry) || seen.has(entry.path) || entry.path === 'manifest.json') throw new Error('packaged runtime manifest entry is invalid')
    seen.add(entry.path)
    verifyRuntimeFile(canonicalRoot, entry)
  }
  if (!isRuntimeWorkbench(manifest.workbench)) throw new Error('packaged Workbench manifest entry is invalid')
  const workbenchTgz = safeResourcePath(canonicalRoot, manifest.workbench.path)
  verifyRegularFileInside(canonicalRoot, workbenchTgz)
  if (digestFile(workbenchTgz) !== manifest.workbench.sha256) throw new Error('packaged Workbench hash mismatch')
  const arch = `${process.platform}-${process.arch}`
  const bundledNodePath = join(canonicalRoot, 'node', arch, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const nodePath = nodeMode === 'electron-run-as-node' ? process.execPath : bundledNodePath
  const pnpmEntry = join(canonicalRoot, 'pnpm', 'bin', 'pnpm.cjs')
  if (nodeMode === 'bundled') verifyRegularFileInside(canonicalRoot, nodePath)
  verifyRegularFileInside(canonicalRoot, pnpmEntry)
  const harnessRoot = join(canonicalRoot, 'harness')
  if (!existsSync(harnessRoot) || !lstatSync(harnessRoot).isDirectory()) throw new Error('packaged harness resource missing')
  const supervisorPath = process.platform === 'win32' ? join(canonicalRoot, 'supervisor', 'runtime-supervisor.exe') : undefined
  if (supervisorPath !== undefined) verifyRegularFileInside(canonicalRoot, supervisorPath)
  return {
    root: canonicalRoot,
    harnessRoot,
    nodePath,
    pnpmEntry,
    workbenchTgz,
    workbenchSha256: manifest.workbench.sha256,
    nodeMode,
    source,
    variant,
    supervisorPath,
  }
}

export function runtimeStatus(
  variant: PackagedVariant,
  layout: RuntimeResourceLayout | undefined,
  error?: unknown,
): RuntimeSourceStatus {
  return {
    variant,
    source: layout?.source ?? 'unavailable',
    rootName: layout === undefined ? null : basename(layout.root),
    error: error === undefined ? null : error instanceof Error ? error.message : String(error),
  }
}

function readManifest(path: string): RuntimeResourceManifest {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('packaged runtime manifest missing')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeResourceManifest
  } catch {
    throw new Error('packaged runtime manifest is invalid')
  }
}

function isRuntimeFileEntry(value: unknown): value is RuntimeResourceFile {
  const entry = value as Partial<RuntimeResourceFile>
  return entry !== null && typeof entry === 'object'
    && typeof entry.path === 'string' && entry.path !== ''
    && (entry.kind === 'file' || entry.kind === 'symlink')
    && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
    && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256)
    && (entry.kind !== 'symlink' || typeof entry.target === 'string' && entry.target !== '')
}

function isRuntimeWorkbench(value: unknown): value is { path: string; sha256: string } {
  const workbench = value as { path?: unknown; sha256?: unknown }
  return typeof workbench?.path === 'string' && workbench.path !== ''
    && typeof workbench.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(workbench.sha256)
}

function verifyRuntimeFile(root: string, entry: RuntimeResourceFile): void {
  const file = safeResourcePath(root, entry.path)
  if (!existsSync(file)) throw new Error(`packaged runtime file missing: ${entry.path}`)
  const link = lstatSync(file)
  if (entry.kind === 'symlink') {
    if (!link.isSymbolicLink()) throw new Error(`packaged runtime symlink mismatch: ${entry.path}`)
    const target = readlinkSync(file)
    const targetPath = resolve(dirname(file), target)
    const targetRelative = relative(root, targetPath)
    if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) throw new Error(`packaged runtime symlink escapes root: ${entry.path}`)
    if (target !== entry.target || entry.sha256 !== hashText(target)) throw new Error(`packaged runtime symlink mismatch: ${entry.path}`)
    verifyRealPathInside(root, file)
    return
  }
  if (link.isSymbolicLink()) throw new Error(`packaged runtime file must not be a symlink: ${entry.path}`)
  const stat = statSync(file)
  if (!stat.isFile() || stat.size !== entry.size || digestFile(file) !== entry.sha256) throw new Error(`packaged runtime hash mismatch: ${entry.path}`)
}

function verifyRegularFileInside(root: string, path: string): void {
  const file = safeResourcePath(root, relative(root, path))
  const link = lstatSync(file)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`packaged runtime file missing: ${relative(root, file)}`)
  verifyRealPathInside(root, file)
}

function verifyRealPathInside(root: string, path: string): void {
  const realRoot = canonicalRuntimeRoot(root)
  const realPath = realpathForVerification(path)
  const escaped = relative(realRoot, realPath)
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error('packaged runtime path escapes root')
}

function canonicalRuntimeRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('external runtime root must be absolute')
  let canonical: string
  try {
    canonical = realpathForVerification(root)
  } catch {
    throw new Error('external runtime root does not exist')
  }
  if (!existsSync(canonical) || !lstatSync(canonical).isDirectory()) throw new Error('external runtime root is not a directory')
  return canonical
}

function realpathForVerification(path: string): string {
  return realpathSync(path)
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
