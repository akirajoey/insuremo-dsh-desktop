import { fork } from 'node:child_process'
import type { RuntimeHandshake } from './contracts.ts'

export interface RuntimeLauncherOptions {
  launchId: string
  dshHome: string
  wrapperPath: string
  cwd?: string
  env?: Record<string, string>
  /** Optional real Node executable for packaged child_process.fork. */
  execPath?: string
  /** Explicit opt-in for the Electron executable's run-as-Node mode. */
  runAsNode?: boolean
}

export interface RuntimeChild {
  pid: number | undefined
  post(message: Record<string, unknown>): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number | null, signal: string | null) => void): void
  onStderr(listener: (chunk: Buffer) => void): void
  kill(): boolean
}

export class RuntimeLauncher {
  static buildEnvironment(options: RuntimeLauncherOptions): Record<string, string> {
    const base = { ...options.env }
    delete base.ELECTRON_RUN_AS_NODE
    if (options.runAsNode === true) base.ELECTRON_RUN_AS_NODE = '1'
    return {
      ...base,
      DSH_HOME: options.dshHome,
      NO_COLOR: '1',
    }
  }

  static sanitizeEnvironment(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) out[key] = value
    }
    return out
  }

  static fork(options: RuntimeLauncherOptions): RuntimeChild {
    const child = fork(options.wrapperPath, [options.launchId], {
      cwd: options.cwd,
      env: RuntimeLauncher.sanitizeEnvironment(RuntimeLauncher.buildEnvironment(options)),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
      ...(options.runAsNode === true && options.execPath !== undefined ? { execArgv: ['--expose-internals'] } : {}),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    return {
      pid: child.pid,
      post: message => { child.send(message) },
      onMessage: listener => { child.on('message', listener) },
      onExit: listener => { child.on('exit', (code, signal) => listener(code, signal)) },
      onStderr: listener => { child.stderr?.on('data', listener) },
      kill: () => child.kill(),
    }
  }
}

export function parseHandshake(message: unknown): RuntimeHandshake | undefined {
  const value = message as { type?: unknown; handshake?: unknown }
  if (value?.type !== 'handshake') return undefined
  const handshake = value.handshake as RuntimeHandshake | undefined
  if (handshake === undefined) return undefined
  if (typeof handshake.launchId !== 'string') return undefined
  if (typeof handshake.pid !== 'number') return undefined
  if (typeof handshake.startTime !== 'number') return undefined
  if (typeof handshake.exec !== 'string') return undefined
  if (typeof handshake.cwd !== 'string') return undefined
  if (typeof handshake.port !== 'number') return undefined
  return handshake
}
