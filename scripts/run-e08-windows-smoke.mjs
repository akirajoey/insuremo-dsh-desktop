import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: 'native Windows runner required' }))
  process.exit(0)
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appPath = process.argv[2] ?? join(root, 'release/win-unpacked/InsureMO DSH Desktop.exe')
const pluginTgz = process.env.DSH_TEST_PLUGIN_TGZ
const userData = process.env.DSH_E08_TEST_USER_DATA ?? mkdtempSync(join(tmpdir(), 'e08-中文 profile '))
const beforeDsh = snapshotTree(join(homedir(), '.dsh'))
if (!existsSync(appPath)) throw new Error(`Windows packaged app missing: ${appPath}`)
if (pluginTgz === undefined || !existsSync(pluginTgz)) throw new Error('DSH_TEST_PLUGIN_TGZ is required for the Windows plugin smoke')

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined && result !== null) return result
    await sleep(200)
  }
  throw new Error(`${label} timeout after ${timeoutMs}ms`)
}
async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
async function target(port, predicate, label) { return waitFor(async () => (await targets(port)).find(predicate), 100_000, label) }
async function evaluate(page, expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id) }
  await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject })
  const result = await new Promise(resolvePromise => { const requestId = ++id; pending.set(requestId, resolvePromise); socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) })
  socket.close()
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.result?.value
}
async function brand(page) {
  const raw = await evaluate(page, `(async()=>{const image=[...document.images].map(i=>({src:i.src,w:i.getBoundingClientRect().width,h:i.getBoundingClientRect().height})).find(i=>i.src.includes('insuremo-wordmark')&&i.w>0&&i.h>0);return JSON.stringify({title:document.title,wordmark:image??null,status:image===undefined?null:(await fetch(image.src)).status})})()`)
  return JSON.parse(raw)
}
async function settings(page) {
  const raw = await evaluate(page, `(async()=>{const response=await fetch('/api/icomposer-workbench/insuremo/overview?fast=0',{headers:{Accept:'application/json'}});const payload=await response.json();return JSON.stringify({httpStatus:response.status,imo:{available:payload?.imo?.available===true,current:typeof payload?.imo?.current==='string'?payload.imo.current:null},skills:{installed:Number.isFinite(payload?.skills?.installed)?payload.skills.installed:0}})})()`)
  return JSON.parse(raw)
}
function snapshotTree(path) {
  if (!existsSync(path)) return null
  const result = []
  const visit = current => { for (const name of readdirSync(current)) { const file = join(current, name); const info = lstatSync(file); const key = relative(path, file).split('\\').join('/'); if (info.isSymbolicLink()) result.push([key, 'link', readlinkSync(file)]); else if (info.isDirectory()) visit(file); else result.push([key, 'file', createHash('sha256').update(readFileSync(file)).digest('hex')]) } }
  visit(path)
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}
function manifest(home = 'harness') {
  const path = join(userData, home, 'profiles/web/package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}
function launch(mode, port) {
  const log = join(tmpdir(), `e08-packaged-${mode}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(appPath, [`--remote-debugging-port=${port}`, ...(mode === 'safe' ? ['--safe-mode'] : [])], {
    cwd: root,
    env: { ...process.env, DSH_DESKTOP_TEST_USER_DATA: userData, DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS: '120000', ...(mode === 'normal' ? { DSH_DESKTOP_TEST_OPEN_PLUGIN_MANAGER: '1', DSH_DESKTOP_TEST_PLUGIN_TGZ: pluginTgz } : {}) },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', fd, fd],
  })
  const closed = new Promise(resolvePromise => child.once('close', (code, signal) => { closeSync(fd); resolvePromise({ code, signal }) }))
  return { child, closed, log: '<temp>/' + relative(tmpdir(), log).replaceAll('\\', '/') }
}
async function stopIfAlive(phase) {
  if (phase.child.exitCode !== null) return
  phase.child.kill()
  await sleep(2_000)
  if (phase.child.exitCode === null) phase.child.kill()
}
function windowsProcesses() {
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'runtime-supervisor|wrapper.cjs' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true })
    const parsed = JSON.parse(output)
    if (parsed === null) return []
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
}
function defender() {
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-MpComputerStatus | Select-Object AMServiceEnabled,RealTimeProtectionEnabled,AntivirusEnabled | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })
    return { available: true, ...JSON.parse(output) }
  } catch { return { available: false, reason: 'Defender status unavailable to test account' } }
}
async function normalPhase() {
  rmSync(userData, { recursive: true, force: true })
  const phase = launch('normal', 9351)
  try {
    const harness = await target(9351, item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'), 'normal harness')
    const plugin = await target(9351, item => item.type === 'page' && item.url.includes('/plugin-manager/index.html'), 'plugin manager')
    const brandResult = await waitFor(async () => { try { const value = await brand(harness); return value.status === 200 ? value : undefined } catch { return undefined } }, 30_000, 'normal brand')
    const settingsResult = await waitFor(async () => { try { const value = await settings(harness); return value.httpStatus === 200 && value.imo.available && value.imo.current === '0.2.20' && value.skills.installed > 0 ? value : undefined } catch { return undefined } }, 60_000, 'Settings IMO/Skills overview')
    const install = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.installCapability('tgz:packaged-smoke')))()`))
    const listed = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.list()))()`))
    const remove = JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.remove('@icomposer/test-plugin')))()`))
    const gone = !(JSON.parse(await evaluate(plugin, `(async()=>JSON.stringify(await window.insuremoPlugins.list()))()`))).some(item => item.name === '@icomposer/test-plugin')
    if (!install.ok || !listed.some(item => item.name === '@icomposer/test-plugin') || !remove.ok || !gone) throw new Error('Windows packaged plugin install/remove failed')
    const closed = await phase.closed
    if (closed.code !== 0 || manifest()?.dependencies?.['@icomposer/workbench'] === undefined) throw new Error('Windows normal phase failed')
    return { brand: brandResult, settings: settingsResult, plugin: { install: true, remove: true, gone: true }, exit: closed, log: phase.log }
  } finally { await stopIfAlive(phase) }
}
async function safePhase() {
  const phase = launch('safe', 9352)
  try {
    const page = await target(9352, item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'), 'safe harness')
    const body = await waitFor(async () => { try { const value = JSON.parse(await evaluate(page, 'JSON.stringify({title:document.title,body:document.body.innerText.slice(0,300)})')); return value.body.length > 20 ? value : undefined } catch { return undefined } }, 30_000, 'safe page')
    const safe = manifest('safe-runtime/harness')
    const normal = manifest()
    const closed = await phase.closed
    if (closed.code !== 0 || safe?.dependencies?.['@icomposer/workbench'] !== undefined || normal?.dependencies?.['@icomposer/workbench'] === undefined) throw new Error('Windows safe phase failed')
    return { page: body, manifest: { normalWorkbench: true, safeWorkbench: false }, exit: closed, log: phase.log }
  } finally { await stopIfAlive(phase) }
}
const result = { ok: false, platform: process.platform, arch: process.arch, unicodePath: /[^ -]/u.test(userData), beforeHomeDsh: beforeDsh === null ? 'absent' : 'present' }
try {
  result.normal = await normalPhase()
  result.safe = await safePhase()
  result.defender = defender()
  result.homeDshUnchanged = JSON.stringify(beforeDsh) === JSON.stringify(snapshotTree(join(homedir(), '.dsh')))
  result.orphanSupervisors = windowsProcesses()
  if (!result.homeDshUnchanged || result.orphanSupervisors.length > 0) throw new Error('Windows cleanup/home invariant failed')
  result.ok = true
} catch (error) { result.error = error instanceof Error ? error.message : String(error); result.orphanSupervisors = windowsProcesses() }
console.log(JSON.stringify(result, null, 2))
if (process.platform === 'win32') writeFileSync(join(root, 'docs/evidence/e08-packaged-smoke-result.json'), JSON.stringify(result, null, 2) + '\n')
if (!result.ok) process.exitCode = 1
