import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appPath = resolve(process.argv[2] ?? join(root, 'release/mac-arm64-Thin/mac-arm64/InsureMO DSH Desktop.app/Contents/MacOS/InsureMO DSH Desktop'))
const runtimeRoot = resolve(process.argv[3] ?? join(root, 'packaging/e07/runtime'))
const pluginTgz = process.env.DSH_TEST_PLUGIN_TGZ ?? '/tmp/e04-test-plugin.tgz'
const invalidPort = 9251
const autoQuitMs = process.env.DSH_TEST_AUTO_QUIT_AFTER_MS ?? '20000'

if (!existsSync(appPath)) throw new Error(`Thin app missing: ${appPath}`)
if (!existsSync(runtimeRoot)) throw new Error(`external runtime missing: ${runtimeRoot}`)
if (!existsSync(pluginTgz)) throw new Error(`test plugin missing: ${pluginTgz}`)

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const targets = async port => {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
const waitTarget = async (port, predicate) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const target = (await targets(port)).find(predicate)
    if (target !== undefined) return target
    await sleep(150)
  }
  throw new Error('Thin Recovery page timeout')
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    const resolvePending = pending.get(message.id)
    if (resolvePending !== undefined) {
      pending.delete(message.id)
      resolvePending(message)
    }
  }
  await new Promise((resolvePromise, reject) => {
    socket.onopen = resolvePromise
    socket.onerror = reject
  })
  const result = await new Promise(resolvePromise => {
    const id = ++sequence
    pending.set(id, resolvePromise)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  socket.close()
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.result?.value
}

async function invalidRecoveryProbe() {
  const userData = mkdtempSync(join(tmpdir(), 'e07-thin-invalid-'))
  const badRoot = join(userData, 'bad-runtime')
  const child = spawn(appPath, ['--no-sandbox', `--remote-debugging-port=${invalidPort}`], {
    cwd: root,
    env: {
      ...process.env,
      DSH_DESKTOP_RUNTIME_ROOT: badRoot,
      DSH_DESKTOP_TEST_USER_DATA: userData,
      DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS: autoQuitMs,
      DSH_DESKTOP_TEST_HEADLESS: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    const target = await waitTarget(invalidPort, value => value.type === 'page' && typeof value.url === 'string' && value.url.includes('/failure/index.html'))
    let text
    const deadline = Date.now() + 10_000
    while (text === undefined && Date.now() < deadline) {
      try { text = await evaluate(target, 'document.body?.innerText') } catch { /* page is still loading */ }
      if (text === undefined) await sleep(150)
    }
    if (typeof text !== 'string' || !text.includes('Select DSH Runtime')) throw new Error('Thin invalid runtime did not show Recovery picker')
    if (text.includes(badRoot)) throw new Error('Recovery page exposed the absolute runtime path')
    return { ok: true, recovery: true, pathHidden: true }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await sleep(1_000)
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(userData, { recursive: true, force: true })
  }
}

function externalRuntimeSmoke() {
  const userData = mkdtempSync(join(tmpdir(), 'e07-thin-external-'))
  try {
    const result = spawnSync(process.execPath, ['scripts/run-e07-packaged-smoke.mjs', appPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 240_000,
      env: {
      ...process.env,
      DSH_DESKTOP_RUNTIME_ROOT: runtimeRoot,
      DSH_TEST_PLUGIN_TGZ: pluginTgz,
      DSH_TEST_AUTO_QUIT_AFTER_MS: '45000',
        DSH_DESKTOP_TEST_HEADLESS: '1',
        DSH_TEST_USER_DATA: userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      const logPath = join(userData, 'logs/harness.log')
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-3000) : ''
      throw new Error(`Thin external smoke exited ${result.status}: ${(result.stderr ?? '').slice(-1000)} ${(result.stdout ?? '').slice(-2000)} ${log}`)
    }
    const smoke = JSON.parse(result.stdout)
    if (smoke.ok !== true || smoke.normal?.settings?.imo?.current !== '0.2.20' || smoke.normal?.settings?.skills?.installed <= 0) {
      throw new Error('Thin external smoke did not prove normal/safe/plugin/Settings')
    }
    return { ok: true, normal: true, safe: true, plugin: true, settings: true, cleanup: smoke.homeDshUnchanged === true && smoke.orphanWrappers?.length === 0 }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
}

let result
try {
  result = {
    ok: true,
    schema: 'Thin external runtime smoke v1',
    app: basename(appPath),
    invalidRecovery: await invalidRecoveryProbe(),
    external: externalRuntimeSmoke(),
  }
} catch (error) {
  result = { ok: false, app: basename(appPath), error: error instanceof Error ? error.stack ?? error.message : String(error) }
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
