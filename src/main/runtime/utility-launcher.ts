import { utilityProcess } from 'electron'
import type { RuntimeChild, RuntimeLauncherOptions } from './launcher.ts'
import { RuntimeLauncher } from './launcher.ts'

export function forkUtilityProcess(options: RuntimeLauncherOptions): RuntimeChild {
  const child = utilityProcess.fork(options.wrapperPath, [options.launchId], {
    cwd: options.cwd,
    env: RuntimeLauncher.sanitizeEnvironment(RuntimeLauncher.buildEnvironment(options)),
    execArgv: ['--expose-internals'],
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'insuremo-dsh-runtime',
  })
  return {
    pid: child.pid,
    post: message => { child.postMessage(message) },
    onMessage: listener => { child.on('message', (message) => listener(message)) },
    onExit: listener => { child.on('exit', (code) => listener(code, null)) },
    onStderr: listener => { child.stderr?.on('data', listener) },
    kill: () => child.kill(),
  }
}
