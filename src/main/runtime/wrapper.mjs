import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DSH_HOME = process.env.DSH_HOME
if (DSH_HOME === undefined || DSH_HOME === '') throw new Error('runtime: DSH_HOME is required')

function controlChannel() {
  const parentPort = process.parentPort
  if (parentPort !== undefined) {
    return {
      post: (message) => parentPort.postMessage(message),
      onMessage: (listener) => parentPort.on('message', (event) => listener(event.data)),
    }
  }
  if (typeof process.send === 'function') {
    return {
      post: (message) => { process.send?.(message) },
      onMessage: (listener) => process.on('message', (message) => listener(message)),
    }
  }
  throw new Error('runtime: control channel unavailable')
}

async function loadAppBoot() {
  const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
  const entry = join(dirname(dshPackage), '../dsh-app-boot/lib/index.js')
  return import(pathToFileURL(entry).href)
}

async function loadProfileBoot() {
  const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
  const libDir = join(dirname(dshPackage), 'lib')
  const moduleFile = readdirSync(libDir).find((name) => /^profile-boot-.*\.js$/u.test(name))
  if (moduleFile === undefined) throw new Error('runtime: profile boot module missing')
  const module = await import(pathToFileURL(join(libDir, moduleFile)).href)
  if (typeof module.runProfile !== 'function') throw new Error('runtime: profile boot runProfile missing')
  return module.runProfile
}

async function main() {
  const launchId = process.argv[2]
  if (launchId === undefined || launchId === '') throw new Error('runtime: launchId is required')
  const channel = controlChannel()
  const appBoot = await loadAppBoot()
  const profileDir = appBoot.resolveProfileDir('web')
  if (!existsSync(join(profileDir, 'package.json'))) {
    appBoot.initProfile(profileDir, appBoot.PROFILE_TEMPLATES.web)
  }
  const runProfile = await loadProfileBoot()
  const startedAt = Date.now()
  const { ctx, shutdown } = await runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    args: ['--host', '127.0.0.1', '--port', '0'],
  })
  const server = ctx.get('webServer')
  if (server?.port === undefined) throw new Error('runtime: web server port missing')
  channel.post({
    type: 'handshake',
    requestId: launchId,
    handshake: {
      launchId,
      pid: process.pid,
      startTime: startedAt,
      exec: process.execPath,
      cwd: process.cwd(),
      port: server.port,
    },
  })
  channel.onMessage((message) => {
    const request = message
    if (request?.type !== 'shutdown' || typeof request.requestId !== 'string') return
    channel.post({ type: 'accepted', requestId: request.requestId })
    shutdown.interrupt(0)
  })
}

await main().catch((error) => {
  console.error('runtime wrapper failed:', error)
  process.exitCode = 1
})
