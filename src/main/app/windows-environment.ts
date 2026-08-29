import { execFileSync } from 'node:child_process'

/**
 * Capture a UTF-8 PowerShell environment when Explorer did not inherit the
 * user's shell profile. This is opt-in in production because a profile can
 * execute arbitrary user code; normal startup still uses Electron's clean
 * process environment. The returned record never mutates process.env.
 */
export function captureWindowsEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) result[key] = value
  if (process.platform !== 'win32' || process.env.DSH_DESKTOP_CAPTURE_POWERSHELL_ENV !== '1') return result
  const command = '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-ChildItem Env: | ConvertTo-Json -Compress'
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 5_000,
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
