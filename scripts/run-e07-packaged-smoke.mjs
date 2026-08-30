import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appPath = process.argv[2] ?? join(root, 'release/mac-arm64/InsureMO DSH Desktop.app/Contents/MacOS/InsureMO DSH Desktop')
const pluginTgz = process.env.DSH_TEST_PLUGIN_TGZ ?? '/tmp/e04-test-plugin.tgz'
const ownsTestUserData = process.env.DSH_TEST_USER_DATA === undefined
const testUserData = process.env.DSH_TEST_USER_DATA ?? mkdtempSync(join(tmpdir(), 'e07-packaged-clean-'))
const autoQuitMs = process.env.DSH_TEST_AUTO_QUIT_AFTER_MS ?? '120000'
const normalPort = 9241
const safePort = 9242
const beforeHomeDsh = snapshotTree(join(process.env.HOME ?? '', '.dsh'))

if (!existsSync(appPath)) throw new Error(`packaged app missing: ${appPath}`)
if (!existsSync(pluginTgz)) throw new Error(`test plugin tgz missing: ${pluginTgz}`)

function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)) }

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && value !== null) return value
    await sleep(200)
  }
  throw new Error(`${label} timeout after ${timeoutMs}ms`)
}

async function targets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

async function waitTarget(port, predicate, label) {
  return waitFor(async () => (await targets(port)).find(predicate), 100_000, label)
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
  const send = (method, params = {}) => new Promise(resolvePromise => {
    const id = ++sequence
    pending.set(id, resolvePromise)
    socket.send(JSON.stringify({ id, method, params }))
  })
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  socket.close()
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.result?.value
}

async function brandProbe(target) {
  const value = await evaluate(target, `(async()=>{const imgs=[...document.images].map(i=>({src:i.src,w:i.getBoundingClientRect().width,h:i.getBoundingClientRect().height,x:i.getBoundingClientRect().x,y:i.getBoundingClientRect().y})).filter(i=>i.w>0&&i.h>0);const word=imgs.find(i=>i.src.includes('insuremo-wordmark'));return JSON.stringify({title:document.title,wordmark:word??null,brandStatus:word===undefined?null:(await fetch(word.src)).status})})()`)
  return JSON.parse(value)
}

async function settingsProbe(target) {
  const value = await evaluate(target, `(async()=>{const response=await fetch('/api/icomposer-workbench/insuremo/overview?fast=0',{headers:{Accept:'application/json'}});const payload=await response.json();return JSON.stringify({httpStatus:response.status,imo:{available:payload?.imo?.available===true,current:typeof payload?.imo?.current==='string'?payload.imo.current:null},skills:{installed:Number.isFinite(payload?.skills?.installed)?payload.skills.installed:0}})})()`)
  return JSON.parse(value)
}

async function waitSettings(target) {
  return waitFor(async () => {
    try {
      const value = await settingsProbe(target)
      return value.httpStatus === 200 && value.imo.available && value.imo.current === '0.2.20' && value.skills.installed > 0 ? value : undefined
    } catch {
      return undefined
    }
  }, 60_000, 'Settings IMO/Skills overview')
}

async function waitBrand(target, label) {
  return waitFor(async () => {
    try {
      const brand = await brandProbe(target)
      return brand.wordmark !== null && brand.brandStatus === 200 ? brand : undefined
    } catch {
      return undefined
    }
  }, 30_000, label)
}

function profileManifest(userData, home = 'harness') {
  const path = join(userData, home, 'profiles/web/package.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function snapshotTree(path) {
  if (!existsSync(path)) return null
  const files = []
  const visit = current => {
    for (const name of readdirSync(current)) {
      const file = join(current, name)
      const link = lstatSync(file)
      const key = relative(path, file).split('\\').join('/')
      if (link.isSymbolicLink()) files.push([key, 'link', readlinkSync(file)])
      else if (link.isDirectory()) visit(file)
      else files.push([key, 'file', createHash('sha256').update(readFileSync(file)).digest('hex')])
    }
  }
  visit(path)
  return files.sort((a, b) => a[0].localeCompare(b[0]))
}

function lanAddress() {
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family === 'IPv4' && !record.internal && !record.address.startsWith('127.')) return record.address
    }
  }
  return undefined
}

async function lanProbe(url) {
  const address = lanAddress()
  if (address === undefined) return { skipped: true, reason: 'no non-loopback IPv4 interface' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(`http://${address}:${new URL(url).port}/`, { signal: controller.signal })
    return { skipped: false, address: '<local-lan>', status: response.status, reachable: true }
  } catch (error) {
    return { skipped: false, address: '<local-lan>', reachable: false, error: error instanceof Error ? error.name : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function processSnapshot() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n').filter(line => line.includes('dsh-runtime/harness/wrapper.cjs'))
  } catch {
    return []
  }
}

async function launch(mode, port, userData, openPluginManager) {
  const logPath = join('/tmp', `e07-packaged-${mode}.log`)
  mkdirSync('/tmp', { recursive: true })
  const fd = openSync(logPath, 'a')
  const child = spawn(appPath, ['--no-sandbox', `--remote-debugging-port=${port}`, ...(mode === 'safe' ? ['--safe-mode'] : [])], {
    cwd: root,
    env: {
      ...process.env,
      DSH_DESKTOP_TEST_USER_DATA: userData,
      DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS: autoQuitMs,
      DSH_DESKTOP_TEST_HEADLESS: '1',
      ...(openPluginManager ? { DSH_DESKTOP_TEST_OPEN_PLUGIN_MANAGER: '1', DSH_DESKTOP_TEST_PLUGIN_TGZ: pluginTgz } : {}),
    },
    stdio: ['ignore', fd, fd],
  })
  const closed = new Promise(resolvePromise => child.once('close', (code, signal) => {
    closeSync(fd)
    resolvePromise({ code, signal })
  }))
  return { child, closed, logPath }
}

async function stopIfAlive(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await sleep(3_000)
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function normalPhase() {
  rmSync(testUserData, { recursive: true, force: true })
  mkdirSync(testUserData, { recursive: true })
  const phase = await launch('normal', normalPort, testUserData, true)
  try {
    const harness = await waitTarget(normalPort, target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'), 'normal harness')
    const plugin = await waitTarget(normalPort, target => target.type === 'page' && target.url.includes('/plugin-manager/index.html'), 'plugin manager')
    const brand = await waitBrand(harness, 'normal brand')
    const settings = await waitSettings(harness)
    const installed = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.installCapability('tgz:packaged-smoke')))()`))
    if (!installed.ok) throw new Error(`packaged tgz install failed: ${JSON.stringify(installed)}`)
    const listed = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.list()))()`))
    if (!listed.some(item => item.name === '@icomposer/test-plugin')) throw new Error('packaged plugin absent after install')
    const removed = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.remove('@icomposer/test-plugin')))()`))
    if (!removed.ok) throw new Error(`packaged tgz remove failed: ${JSON.stringify(removed)}`)
    const remaining = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.list()))()`))
    if (remaining.some(item => item.name === '@icomposer/test-plugin')) throw new Error('packaged plugin remains after remove')
    const lan = await lanProbe(harness.url)
    if (!lan.skipped && lan.reachable) throw new Error(`LAN unexpectedly reachable: ${JSON.stringify(lan)}`)
    const manifest = profileManifest(testUserData)
    if (manifest?.dependencies?.['@icomposer/workbench'] === undefined) throw new Error('normal packaged profile lacks Workbench')
    const closed = await phase.closed
    if (closed.code !== 0) throw new Error(`normal packaged app exit: ${JSON.stringify(closed)}`)
    if (existsSync(join(testUserData, 'desktop-state/runtime-owner.json'))) throw new Error('normal ownership marker remains')
    return { mode: 'normal', brand, settings, plugin: { install: true, remove: true, gone: true }, lan, manifest: { workbench: true }, exit: closed, logPath: '<temp>/e07-packaged-normal.log' }
  } finally {
    await stopIfAlive(phase.child)
  }
}

async function safePhase() {
  const phase = await launch('safe', safePort, testUserData, false)
  try {
    const harness = await waitTarget(safePort, target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'), 'safe harness')
    const page = await waitFor(async () => {
      try {
        const value = JSON.parse(await evaluate(harness, 'JSON.stringify({ title: document.title, body: document.body.innerText.slice(0, 300) })'))
        return value.body.length < 20 || value.body.includes('Loading plugins') ? undefined : value
      } catch {
        return undefined
      }
    }, 30_000, 'safe page')
    if (page.body === '') throw new Error(`safe page empty: ${JSON.stringify(page)}`)
    const safeManifest = profileManifest(testUserData, 'safe-runtime/harness')
    const normalManifest = profileManifest(testUserData)
    if (safeManifest?.dependencies?.['@icomposer/workbench'] !== undefined) throw new Error('safe profile contains Workbench')
    if (normalManifest?.dependencies?.['@icomposer/workbench'] === undefined) throw new Error('normal profile lost Workbench after safe boot')
    const closed = await phase.closed
    if (closed.code !== 0) throw new Error(`safe packaged app exit: ${JSON.stringify(closed)}`)
    if (existsSync(join(testUserData, 'desktop-state/runtime-owner.json'))) throw new Error('safe ownership marker remains')
    return { mode: 'safe', page, manifest: { normalWorkbench: true, safeWorkbench: false }, exit: closed, logPath: '<temp>/e07-packaged-safe.log' }
  } finally {
    await stopIfAlive(phase.child)
  }
}

const result = { ok: false, arch: process.arch, app: basename(appPath), beforeHomeDsh: beforeHomeDsh === null ? 'absent' : 'present' }
try {
  result.normal = await normalPhase()
  result.safe = await safePhase()
  const afterHomeDsh = snapshotTree(join(process.env.HOME ?? '', '.dsh'))
  result.homeDshUnchanged = JSON.stringify(beforeHomeDsh) === JSON.stringify(afterHomeDsh)
  if (!result.homeDshUnchanged) throw new Error('packaged smoke modified ~/.dsh')
  result.orphanWrappers = processSnapshot()
  if (result.orphanWrappers.length > 0) throw new Error(`orphan runtime wrappers: ${JSON.stringify(result.orphanWrappers)}`)
  result.ok = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  result.normalProcess = processSnapshot()
}
writeFileSync('/tmp/e07-packaged-smoke-result.json', JSON.stringify(result, null, 2) + '\n')
if (ownsTestUserData) rmSync(testUserData, { recursive: true, force: true })
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
