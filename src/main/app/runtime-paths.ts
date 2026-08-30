import { existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { appRoot } from './app-root.ts'
import { packagedResourceRoot } from './runtime-resources.ts'

function fromEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment[name]
  return value === undefined || value === '' ? undefined : value
}

function commandPath(command: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(lookup, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: environment }).trim().split(/\r?\n/u)[0]
    return result === '' ? undefined : result
  } catch {
    return undefined
  }
}

/** Resolve real Node (never Electron's execPath) for the pnpm launcher. */
export function resolveNodePath(environment: NodeJS.ProcessEnv = process.env): string {
  if (app.isPackaged) {
    if (process.platform === 'darwin' && environment.DSH_DESKTOP_EXPERIMENT_ELECTRON_NODE === '1') return process.execPath
    const bundled = join(packagedResourceRoot(), 'node', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'node.exe' : 'bin/node')
    if (!existsSync(bundled)) throw new Error('packaged Node executable is missing')
    return bundled
  }
  const configured = fromEnvironment('DSH_DESKTOP_NODE_PATH', environment)
  if (configured !== undefined) return configured
  const bundled = process.platform === 'win32'
    ? join(process.resourcesPath, 'node', 'node.exe')
    : join(process.resourcesPath, 'node', 'bin', 'node')
  if (existsSync(bundled)) return bundled
  const discovered = commandPath(process.platform === 'win32' ? 'node.exe' : 'node', environment)
  return discovered ?? (process.platform === 'win32' ? 'node.exe' : 'node')
}

/** Resolve pnpm's JavaScript entry, not the shell shim. */
export function resolvePnpmEntry(environment: NodeJS.ProcessEnv = process.env): string {
  if (app.isPackaged) {
    const bundled = join(packagedResourceRoot(), 'pnpm', 'bin', 'pnpm.cjs')
    if (!existsSync(bundled)) throw new Error('packaged pnpm entry is missing')
    return bundled
  }
  const configured = fromEnvironment('DSH_DESKTOP_PNPM_ENTRY', environment)
  if (configured !== undefined) return configured
  const bundled = join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(bundled)) return bundled
  const shim = commandPath(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', environment)
  if (shim !== undefined) {
    const real = realpathSafe(shim)
    if (real !== undefined && existsSync(real) && real.endsWith('.cjs')) return real
    const candidates = [
      join(dirname(shim), '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dirname(shim), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ]
    const candidate = candidates.find(path => existsSync(path))
    if (candidate !== undefined) return candidate
  }
  const local = join(appRoot(), 'node_modules/pnpm/bin/pnpm.cjs')
  if (existsSync(local)) return local
  // A clear failure is safer than trying to execute an arbitrary shell shim.
  throw new Error('pnpm JavaScript entry is not available; configure DSH_DESKTOP_PNPM_ENTRY')
}

function realpathSafe(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}
