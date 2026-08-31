import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') as string
const root = resolve(import.meta.dirname, '..')

let tmp: string
let child: ReturnType<typeof spawn> | undefined

beforeAll(() => {
  // The driver exercises the built production main bundle. For dev runs the
  // main bundle must be rebuilt; packaged runs (DSH_ACTIVATE_DRIVER_APP) use
  // the installed bundle as-is.
  if (process.env.DSH_ACTIVATE_DRIVER_APP === undefined) {
    execFileSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'ignore', timeout: 240_000 })
  }
  tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e07-activate-'))
}, 300_000)

afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
})

interface ActivateResult {
  ok: boolean
  error?: string
  harnessPort?: string
  electronPid?: number
  burstCount?: number
  burstUrl?: string
  restoreCount?: number
  restoredMinimized?: boolean
  duringBootCount?: number
  afterCloseCount?: number
  afterCloseReady?: boolean
  explicitBefore?: number
  explicitAfter?: number
  snapshotUrl?: boolean
}

function wrapperOrphans(): string[] {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes('dsh-runtime/harness/wrapper.cjs'))
  } catch {
    return []
  }
}

function userDataReferences(userData: string): string[] {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes(userData))
  } catch {
    return []
  }
}

function listenersOnPort(port: string): string[] {
  if (port === '') return []
  try {
    return execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .filter(line => line.trim() !== '')
  } catch {
    return []
  }
}

describe('TASK-074 activate single-flight (hidden Electron integration)', () => {
  it('never duplicates windows, and quits cleanly through before-quit with zero orphans', async () => {
    const userData = join(tmp, 'userData')
    const packagedApp = process.env.DSH_ACTIVATE_DRIVER_APP
    child = spawn(packagedApp ?? electronBinary, packagedApp ? ['--no-sandbox'] : ['.'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        DSH_DESKTOP_TEST_USER_DATA: userData,
        DSH_DESKTOP_TEST_ACTIVATE_DRIVER: '1',
        DSH_DESKTOP_TEST_KEEP_ALIVE_ON_ALL_CLOSED: '1',
        DSH_DESKTOP_TEST_HEADLESS: '1',
        DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS: '240000',
      },
    })
    const stderr: string[] = []
    child.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const resultPath = join(userData, 'logs', 'activate-result.json')
    const deadline = Date.now() + 180_000
    let raw: string | undefined
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        try { raw = readFileSync(resultPath, 'utf8'); break } catch { /* still writing */ }
      }
      if (child.exitCode !== null) throw new Error(`driver exited early (${child.exitCode}): ${stderr.join('').slice(-2000)}`)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    expect(raw, `driver result missing; stderr: ${stderr.join('').slice(-2000)}`).toBeDefined()
    const result = JSON.parse(raw as string) as ActivateResult
    expect(result.error, `driver error: ${result.error ?? ''}`).toBeUndefined()
    // 1) Five consecutive activations keep exactly one harness window.
    expect(result.burstCount).toBe(1)
    expect(result.burstUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):/)
    // 2) Minimized window is restored, not duplicated.
    expect(result.restoreCount).toBe(1)
    expect(result.restoredMinimized).toBe(false)
    // 3) Activations during an in-flight boot never duplicate.
    expect(result.duringBootCount).toBe(1)
    // 4) After all windows closed, activation creates exactly one ready window.
    expect(result.afterCloseCount).toBe(1)
    expect(result.afterCloseReady).toBe(true)
    // 5) Explicit New Window: 1 (recreated in step 4) + 3 = 4.
    expect(result.explicitBefore).toBe(1)
    expect(result.explicitAfter).toBe(4)
    expect(result.snapshotUrl).toBe(true)

    // Clean-quit gate: the driver only wrote its result and called app.quit();
    // the process must reach exit on its own (before-quit → harness.stop).
    // The test must never kill it.
    const exited = await Promise.race([
      new Promise<number | null>(resolvePromise => child?.once('exit', code => resolvePromise(code))),
      new Promise<'timeout'>(resolvePromise => setTimeout(() => resolvePromise('timeout'), 120_000)),
    ])
    expect(exited, 'app did not quit by itself within 120s (clean-quit violation)').not.toBe('timeout')

    // Orphan gate: no runtime wrapper, no process referencing the isolated
    // userData, and no leftover harness listener after the app is gone.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    expect(wrapperOrphans()).toEqual([])
    expect(userDataReferences(userData)).toEqual([])
    expect(listenersOnPort(result.harnessPort ?? '')).toEqual([])
    // userData is fully released by the exited app.
    expect(() => rmSync(userData, { recursive: true, force: true })).not.toThrow()
  }, 300_000)
})
