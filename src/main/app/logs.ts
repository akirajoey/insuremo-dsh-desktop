import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function logsDir(userData: string): string {
  return join(userData, 'logs')
}

export function harnessLogPath(userData: string, mode: 'normal' | 'safe'): string {
  return join(logsDir(userData), mode === 'safe' ? 'harness-safe.log' : 'harness.log')
}

export function appendHarnessLog(userData: string, mode: 'normal' | 'safe', line: string): void {
  try {
    mkdirSync(logsDir(userData), { recursive: true })
    appendFileSync(harnessLogPath(userData, mode), line)
  } catch {
    // Logging must never break the runtime.
  }
}

export function logTail(path: string, maxLines: number): string {
  if (!existsSync(path)) return ''
  try {
    const content = readFileSync(path, 'utf8')
    const lines = content.split('\n')
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}
