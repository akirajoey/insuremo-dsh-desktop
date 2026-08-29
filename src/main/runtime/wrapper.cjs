'use strict'
const { existsSync, readdirSync, mkdirSync, appendFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { createInterface } = require('node:readline')

const require2 = createRequire(__filename)
const DSH_HOME = process.env.DSH_HOME
if (DSH_HOME === undefined || DSH_HOME === '') throw new Error('runtime: DSH_HOME is required')

// Mirror console output into the desktop log file so the failure page and
// the Logs menu can show real harness output without stderr races.
const DESKTOP_LOG = process.env.DSH_DESKTOP_LOG
function serializePart(part) {
  if (part instanceof Error) return { name: part.name, message: part.message, stack: part.stack }
  return part
}
function logLine(level, parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.map((p) => {
    const value = serializePart(p)
    return typeof value === 'string' ? value : JSON.stringify(value)
  }).join(' ')}\n`
  if (DESKTOP_LOG !== undefined && DESKTOP_LOG !== '') {
    try {
      mkdirSync(dirname(DESKTOP_LOG), { recursive: true })
      appendFileSync(DESKTOP_LOG, line)
    } catch {
      // Logging must never break the runtime.
    }
  }
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...parts) => {
    logLine(level, parts)
    original(...parts)
  }
}

function controlChannel() {
  if (process.argv.includes('--windows-supervisor')) {
    const input = createInterface({ input: process.stdin })
    return {
      post: (message) => process.stdout.write(`__DSH_CONTROL__${JSON.stringify(message)}\n`),
      onMessage: (listener) => input.on('line', (line) => {
        try { listener(JSON.parse(line)) } catch { /* malformed supervisor input is ignored */ }
      }),
    }
  }
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
  const dshPackage = require2.resolve('@deepseek-ai/dsh/package.json')
  const entry = join(dirname(dshPackage), '../dsh-app-boot/lib/index.js')
  return import(pathToFileURL(entry).href)
}

async function loadProfileBoot() {
  const dshPackage = require2.resolve('@deepseek-ai/dsh/package.json')
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

main().catch((error) => {
  console.error('runtime wrapper failed:', serializePart(error))
  process.exit(1)
})