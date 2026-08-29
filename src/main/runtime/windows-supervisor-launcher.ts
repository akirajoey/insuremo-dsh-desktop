import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type { RuntimeChild, RuntimeLauncherOptions } from './launcher.ts'
import { RuntimeLauncher } from './launcher.ts'

export interface WindowsSupervisorOptions extends RuntimeLauncherOptions {
  supervisorPath: string
  parentPid?: number
}

export function quoteWindowsArgument(value: string): string {
  let result = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') backslashes += 1
    else if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      result += '\\'.repeat(backslashes) + character
      backslashes = 0
    }
  }
  return result + '\\'.repeat(backslashes * 2) + '"'
}

/** Main talks to the supervisor through
 * its current-user-only named pipe; the supervisor owns the Job Object and
 * forwards the newline-framed wrapper protocol. No shell-based termination path is used.
 */
export function forkWindowsSupervisor(options: WindowsSupervisorOptions): RuntimeChild {
  if (process.platform !== 'win32') throw new Error('Windows supervisor is only available on win32')
  if (options.execPath === undefined || options.execPath === '') throw new Error('bundled Windows Node path is required')
  const pipeName = `\\\\.\\pipe\\insuremo-dsh-${options.launchId}-${randomUUID()}`
  const child = spawn(options.supervisorPath, [
    `--node=${options.execPath}`,
    `--wrapper=${options.wrapperPath}`,
    `--launch-id=${options.launchId}`,
    `--pipe=${pipeName}`,
    `--parent-pid=${options.parentPid ?? process.ppid}`,
    ...(options.cwd === undefined ? [] : [`--cwd=${options.cwd}`]),
  ], {
    cwd: options.cwd,
    env: RuntimeLauncher.sanitizeEnvironment(RuntimeLauncher.buildEnvironment(options)),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const messageListeners: Array<(message: unknown) => void> = []
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = []
  const pending: string[] = []
  let socket: Socket | undefined
  let connected = false
  let stopped = false
  let receiveBuffer = ''

  const notify = (message: unknown): void => {
    for (const listener of messageListeners) listener(message)
  }
  const connect = (): void => {
    if (stopped || connected) return
    const candidate = createConnection(pipeName)
    socket = candidate
    candidate.setEncoding('utf8')
    candidate.on('connect', () => {
      connected = true
      for (const message of pending.splice(0)) candidate.write(message)
    })
    candidate.on('data', chunk => {
      receiveBuffer += String(chunk)
      let newline = -1
      while ((newline = receiveBuffer.indexOf('\n')) >= 0) {
        const line = receiveBuffer.slice(0, newline).trim()
        receiveBuffer = receiveBuffer.slice(newline + 1)
        if (line === '') continue
        try { notify(JSON.parse(line)) } catch { /* supervisor diagnostics stay on stderr */ }
      }
    })
    candidate.on('error', () => {
      connected = false
      if (!stopped) setTimeout(connect, 50)
    })
    candidate.on('close', () => { connected = false })
  }
  connect()

  child.stderr?.on('data', chunk => {
    // RuntimeController attaches its stderr listener after construction. Keep
    // the stream flowing even when no listener is installed yet.
    void chunk
  })
  child.on('exit', (code, signal) => {
    stopped = true
    socket?.destroy()
    for (const listener of exitListeners) listener(code, signal)
  })

  return {
    pid: child.pid,
    post: message => {
      const line = `${JSON.stringify(message)}\n`
      if (connected && socket !== undefined) socket.write(line)
      else pending.push(line)
    },
    onMessage: listener => { messageListeners.push(listener) },
    onExit: listener => { exitListeners.push(listener) },
    onStderr: listener => { child.stderr?.on('data', listener) },
    kill: () => {
      stopped = true
      socket?.destroy()
      // Closing the supervisor causes its Job Object to kill the complete
      // child tree. This is the forced path; it is not the normal shutdown.
      return child.kill()
    },
  }
}
