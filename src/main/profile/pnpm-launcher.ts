import { spawn } from 'node:child_process'
import { captureDesktopEnvironment } from '../app/windows-environment.ts'

export interface PnpmLauncherOptions {
  /** Absolute bundled Node executable. */
  nodePath: string
  /** Absolute pnpm JS entry (bin/pnpm.cjs). */
  pnpmEntry: string
  /** Working directory (the profile directory). */
  cwd: string
  /** Captured shell environment; defaults to the safe desktop capture. */
  environment?: Record<string, string>
  /** Explicit opt-in for an Electron executable used as Node. */
  runAsNode?: boolean
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Timeout for the pnpm invocation. */
  timeoutMs?: number
}

export interface PnpmResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Run pnpm with a fixed verb and argument list through the bundled Node
 * executable. Never uses a shell, never accepts arbitrary argv, and never
 * touches the Windows `shell:true` forwarding path of the official CLI.
 */
export class PnpmLauncher {
  static readonly FIXED_VERBS = new Set(['add', 'remove', 'update', 'install'])

  static assertSafeSpec(spec: string): void {
    if (spec.length === 0) throw new Error('pnpm: empty spec')
    if (spec.includes('\0')) throw new Error('pnpm: NUL in spec')
    if (spec.startsWith('-')) throw new Error('pnpm: spec must not start with -')
    if (spec.includes('--')) throw new Error('pnpm: options are not allowed in specs')
  }

  static async run(options: PnpmLauncherOptions, verb: string, args: string[]): Promise<PnpmResult> {
    if (!PnpmLauncher.FIXED_VERBS.has(verb)) {
      throw new Error(`pnpm: verb ${verb} is not allowed`)
    }
    // pnpm flags (starting with -- or -) are fixed verb-options, not user specs.
    for (const argument of args) {
      if (!argument.startsWith('-')) PnpmLauncher.assertSafeSpec(argument)
    }
    const environment = { ...(options.environment ?? captureDesktopEnvironment()), ...options.env }
    delete environment.ELECTRON_RUN_AS_NODE
    if (options.runAsNode === true) environment.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(options.nodePath, [options.pnpmEntry, verb, ...args], {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, options.timeoutMs ?? 120_000)
    return new Promise<PnpmResult>(resolve => {
      child.on('error', error => {
        clearTimeout(timer)
        resolve({ exitCode: (error as { code?: string }).code === 'ENOENT' ? 127 : 1, stdout, stderr: String(error) })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ exitCode: signal !== null ? 124 : (code ?? 1), stdout, stderr })
      })
    })
  }
}
