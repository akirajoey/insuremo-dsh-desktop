import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const MAC_STANDARD_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const
const MAX_LOGIN_ENV_BYTES = 512 * 1024
const LOGIN_SHELL_TIMEOUT_MS = 5_000

/**
 * Capture a UTF-8 PowerShell environment when Explorer did not inherit the
 * user's shell profile. This remains opt-in because a PowerShell profile can
 * execute arbitrary user code. The returned record never mutates process.env.
 */
export function captureWindowsEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result = copyEnvironment(base)
  if (process.platform !== 'win32' || process.env.DSH_DESKTOP_CAPTURE_POWERSHELL_ENV !== '1') return result
  const command = '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-ChildItem Env: | ConvertTo-Json -Compress'
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      maxBuffer: MAX_LOGIN_ENV_BYTES,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(output) as Record<string, string> | Array<{ Name?: string; Value?: string }>
    if (Array.isArray(parsed)) {
      for (const item of parsed) if (item.Name !== undefined && item.Value !== undefined) result[item.Name] = item.Value
    } else {
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') result[key] = value
    }
  } catch {
    // Explorer launch remains valid when PowerShell is unavailable or blocked.
  }
  result.LANG = result.LANG ?? 'en_US.UTF-8'
  result.LC_ALL = result.LC_ALL ?? 'en_US.UTF-8'
  return result
}

/**
 * Resolve a bare executable using only an explicit PATH. This is deliberately
 * filesystem-only so the Finder seam can be tested without invoking a shell.
 */
export function resolveExecutableFromEnvironment(command: string, environment: Readonly<Record<string, string>>): string | undefined {
  if (command.length === 0 || command.includes('\0')) return undefined
  if (isAbsolute(command)) return isExecutable(command) ? command : undefined
  const path = environment.PATH ?? ''
  for (const directory of path.split(delimiter)) {
    if (directory === '' || !isAbsolute(directory)) continue
    const candidate = join(directory, command)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Capture a safe, bounded login-shell PATH for macOS Finder launches. Only
 * PATH is imported from the shell output; HOME, auth variables, and all other
 * values remain from the already inherited environment. Shell output is held
 * in memory only and is never logged or persisted.
 */
export function captureLoginShellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  runLoginShell: () => string | Buffer = defaultLoginShellCapture,
): Record<string, string> {
  const result = copyEnvironment(base)
  const basePath = result.PATH
  let loginPath = ''
  if (process.platform === 'darwin') {
    try {
      const output = runLoginShell()
      if (Buffer.byteLength(output) <= MAX_LOGIN_ENV_BYTES) loginPath = parseLoginPath(output)
    } catch {
      // The deterministic standard-path fallback below is sufficient for IMO.
    }
  }
  result.PATH = mergeExecutablePaths(basePath, loginPath, MAC_STANDARD_PATHS.join(delimiter))
  return result
}

/** Build the environment shared by the runtime and desktop-side pnpm calls. */
export function captureDesktopEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (process.platform === 'darwin') return captureLoginShellEnvironment(base)
  if (process.platform === 'win32') return captureWindowsEnvironment(base)
  return copyEnvironment(base)
}

/** Merge absolute PATH entries with stable ordering and no duplicate entries. */
export function mergeExecutablePaths(...paths: readonly (string | undefined)[]): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const value of paths) {
    for (const directory of (value ?? '').split(delimiter)) {
      if (directory === '' || !isAbsolute(directory) || seen.has(directory)) continue
      seen.add(directory)
      merged.push(directory)
    }
  }
  return merged.join(delimiter)
}

function defaultLoginShellCapture(): Buffer {
  return execFileSync('/bin/zsh', ['-ilc', '/usr/bin/env -0'], {
    encoding: 'buffer',
    timeout: LOGIN_SHELL_TIMEOUT_MS,
    maxBuffer: MAX_LOGIN_ENV_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  }) as Buffer
}

function parseLoginPath(output: string | Buffer): string {
  const entries = output.toString('utf8').split('\0')
  for (const entry of entries) {
    if (entry.startsWith('PATH=')) return entry.slice('PATH='.length)
  }
  return ''
}

function copyEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) result[key] = value
  return result
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile() && (process.platform === 'win32' || (accessSync(path, constants.X_OK), true))
  } catch {
    return false
  }
}
