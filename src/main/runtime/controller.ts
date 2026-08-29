import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeChild, RuntimeLauncherOptions } from './launcher.ts'
import { parseHandshake } from './launcher.ts'
import type { ChildExit, ControlState, RuntimeHandshake, RuntimeSnapshot, ShutdownOutcome } from './contracts.ts'

export interface RuntimeControllerOptions {
  launchId: string
  dshHome: string
  wrapperPath: string
  cwd: string
  env: Record<string, string>
  userData: string
  startTimeoutMs?: number
  readySettleMs?: number
  shutdownGraceMs?: number
  forkMode?: 'fork' | 'utility'
  /** Real Node path used when forkMode is child_process.fork. */
  execPath?: string
  /** Signed Windows helper that owns the bundled Node Job Object. */
  supervisorPath?: string
}

interface OwnershipRecord {
  launchId: string
  pid: number
  startTime: number
  exec: string
  cwd: string
  writtenAt: number
}

export class RuntimeController {
  private readonly launchId: string
  private readonly dshHome: string
  private readonly wrapperPath: string
  private readonly cwd: string
  private readonly env: Record<string, string>
  private readonly userData: string
  private readonly startTimeoutMs: number
  private readonly readySettleMs: number
  private readonly shutdownGraceMs: number
  private readonly forkMode: 'fork' | 'utility'
  private readonly execPath: string | undefined
  private readonly supervisorPath: string | undefined
  private state: ControlState = 'idle'
  private child: RuntimeChild | undefined
  private handshake: RuntimeHandshake | undefined
  private exit: ChildExit | undefined
  private ownershipPath = ''
  private stderrTail = ''

  constructor(options: RuntimeControllerOptions) {
    this.launchId = options.launchId
    this.dshHome = options.dshHome
    this.wrapperPath = options.wrapperPath
    this.cwd = options.cwd
    this.env = options.env
    this.userData = options.userData
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000
    this.readySettleMs = options.readySettleMs ?? 500
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000
    this.forkMode = options.forkMode ?? 'fork'
    this.execPath = options.execPath
    this.supervisorPath = options.supervisorPath
    this.ownershipPath = join(this.userData, 'desktop-state', 'runtime-owner.json')
  }

  get phase(): RuntimeSnapshot['phase'] {
    if (this.state === 'exited') return 'idle'
    if (this.state === 'forced' || this.state === 'timeout') return 'failed'
    if (this.handshake !== undefined) return 'ready'
    return 'starting'
  }

  snapshot(): RuntimeSnapshot {
    const url = this.handshake !== undefined ? `http://127.0.0.1:${this.handshake.port}` : undefined
    return {
      phase: this.phase,
      url,
      message: this.handshake !== undefined ? `listening on port ${this.handshake.port}` : this.state,
    }
  }

  async start(): Promise<RuntimeSnapshot> {
    if (this.child !== undefined) return this.snapshot()
    const startedAt = Date.now()
    const launcher = await import('./launcher.ts')
    const options: RuntimeLauncherOptions = {
      launchId: this.launchId,
      dshHome: this.dshHome,
      wrapperPath: this.wrapperPath,
      cwd: this.cwd,
      env: this.env,
      execPath: this.execPath,
    }
    const child = this.supervisorPath !== undefined && process.platform === 'win32'
      ? (await import('./windows-supervisor-launcher.ts')).forkWindowsSupervisor({ ...options, supervisorPath: this.supervisorPath, parentPid: process.pid })
      : this.forkMode === 'utility'
        ? (await import('./utility-launcher.ts')).forkUtilityProcess(options)
        : launcher.RuntimeLauncher.fork(options)
    this.child = child
    this.stderrTail = ''
    child.onStderr(chunk => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
    })
    child.onExit((code, signal) => {
      this.exit = { code, signal, elapsedMs: Date.now() - startedAt }
      if (this.state !== 'forced' && this.state !== 'timeout') this.state = 'exited'
      this.removeOwnership()
    })
    child.onMessage(message => {
      const handshake = parseHandshake(message)
      if (handshake !== undefined) {
        this.handshake = handshake
        this.writeOwnership(handshake)
      } else {
        const type = (message as { type?: unknown }).type
        if (type === 'accepted') this.state = 'accepted'
        if (type === 'exited') {
          const value = message as { code?: unknown; signal?: unknown; elapsedMs?: unknown }
          this.exit = {
            code: typeof value.code === 'number' ? value.code : null,
            signal: typeof value.signal === 'string' ? value.signal : null,
            elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : 0,
          }
          this.state = 'exited'
          this.removeOwnership()
        }
        if (type === 'timeout') this.state = 'timeout'
        if (type === 'forced') this.state = 'forced'
      }
    })
    return this.snapshot()
  }

  async waitUntilReady(): Promise<RuntimeSnapshot> {
    const deadline = Date.now() + this.startTimeoutMs
    let stableAt = 0
    while (Date.now() < deadline) {
      if (this.handshake !== undefined) {
        if (stableAt === 0) stableAt = Date.now()
        if (Date.now() - stableAt >= this.readySettleMs) return this.snapshot()
      } else {
        stableAt = 0
      }
      if (this.state === 'exited' || this.exit !== undefined) {
        return { phase: 'failed', message: `runtime exited before ready (${this.exit?.code ?? 'signal'}): ${this.stderrTail.slice(-800)}` }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { phase: 'failed', message: 'runtime start timed out' }
  }

  async requestShutdown(timeoutMs?: number): Promise<ShutdownOutcome> {
    const grace = timeoutMs ?? this.shutdownGraceMs
    if (this.exit !== undefined) {
      this.removeOwnership()
      return { kind: 'exited', exit: this.exit }
    }
    if (this.child === undefined) return { kind: 'exited', exit: this.exit ?? { code: null, signal: null, elapsedMs: 0 } }
    const requestId = `${this.launchId}-shutdown`
    this.state = 'accepted'
    this.child.post({ type: 'shutdown', requestId })
    const exited = await new Promise<ChildExit | undefined>(resolve => {
      const check = (code: number | null, signal: string | null) => resolve({ code, signal, elapsedMs: Date.now() })
      this.child?.onExit(check)
      setTimeout(() => resolve(undefined), grace)
    })
    if (exited !== undefined) return { kind: 'exited', exit: exited }
    this.state = 'timeout'
    const killed = this.child?.kill() ?? false
    this.state = killed ? 'forced' : 'timeout'
    // The child may emit exit after Electron begins quitting; remove the
    // ownership marker now so a forced shutdown cannot leave stale state.
    this.removeOwnership()
    return { kind: killed ? 'forced' : 'timeout', exit: this.exit }
  }

  async cleanup(): Promise<void> {
    if (this.child !== undefined) {
      this.child.kill()
    }
    this.removeOwnership()
  }

  private writeOwnership(handshake: RuntimeHandshake): void {
    const record: OwnershipRecord = {
      launchId: this.launchId,
      pid: handshake.pid,
      startTime: handshake.startTime,
      exec: handshake.exec,
      cwd: handshake.cwd,
      writtenAt: Date.now(),
    }
    mkdirSync(join(this.userData, 'desktop-state'), { recursive: true })
    writeFileSync(this.ownershipPath, JSON.stringify(record))
  }

  private removeOwnership(): void {
    if (existsSync(this.ownershipPath)) rmSync(this.ownershipPath, { force: true })
  }
}
