#!/usr/bin/env node
/**
 * TASK-087 packaged diagnosis smoke.
 *
 * This is a bounded, isolated UI smoke for the Workbench diagnostic hand-off:
 * a temporary fake npx emits a canary and exits 1, while a read-only npm shim
 * answers the real IMO launcher's local version probes. The packaged stock
 * rc.7 runtime captures the failure, and the real Settings UI opens a
 * diagnostic workspace with an editable prefilled draft. No registry/global
 * install and no model request are performed. The temporary app userData/HOME
 * are kept in the result for inspection and can be removed manually after the
 * run.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const expectedWorkbenchSha256 = (process.env.DSH_WORKBENCH_SHA256
  ?? '1e205bd8eac1b76f521bcd3430bec1e02c66f26268e1719b05856bbab2506be5').toLowerCase()
const defaultApp = join(root, 'release/mac-arm64-Full/mac-arm64/InsureMO DSH Desktop.app')
const requestedApp = process.env.DSH_DIAGNOSIS_APP ?? process.argv[2] ?? defaultApp
const appBundle = requestedApp.endsWith('.app') ? requestedApp : resolve(requestedApp, '../../..')
const appBinary = requestedApp.endsWith('.app')
  ? join(requestedApp, 'Contents/MacOS/InsureMO DSH Desktop')
  : requestedApp
const outputPath = process.env.DSH_DIAGNOSIS_SMOKE_OUTPUT ?? '/tmp/e07-diagnosis-smoke-result.json'
const logPath = process.env.DSH_DIAGNOSIS_SMOKE_LOG ?? '/tmp/e07-diagnosis-packaged.log'
const canary = process.env.DSH_DIAGNOSIS_CANARY ?? `TASK-087-PACKAGED-${Date.now().toString(36)}`
const smokeRoot = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e07-diagnosis-'))
const userData = join(smokeRoot, 'userData')
const home = join(smokeRoot, 'home')
const fakeBin = join(smokeRoot, 'fakebin')
const marker = join(smokeRoot, 'fake-npx-runs.log')
const npmCache = join(smokeRoot, 'npm-cache')
const npmPrefix = join(smokeRoot, 'npm-prefix')
const xdgConfig = join(smokeRoot, 'xdg-config')
const xdgCache = join(smokeRoot, 'xdg-cache')
mkdirSync(userData, { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(fakeBin, { recursive: true })
mkdirSync(npmCache, { recursive: true })
mkdirSync(npmPrefix, { recursive: true })
mkdirSync(xdgConfig, { recursive: true })
mkdirSync(xdgCache, { recursive: true })
writeFileSync(join(fakeBin, 'npx'), [
  '#!/bin/sh',
  'printf "%s\\n" "synthetic npx stdout (TASK-087 packaged diagnosis)"',
  'printf "%s\\n" "synthetic npx stderr canary=$SMOKE_CANARY" >&2',
  'printf "%s\\n" "$SMOKE_CANARY" >> "$SMOKE_NPX_MARKER"',
  'exit 1',
  '',
].join('\n'), { mode: 0o755 })
// The real IMO launcher performs a read-only `npm view` during its upgrade
// check. Keep the host overview deterministic without allowing that probe to
// leave the isolated registry: this shim answers only read-only queries and
// has no install/write branch. `imo` itself remains the host executable.
writeFileSync(join(fakeBin, 'npm'), [
  '#!/bin/sh',
  'case "$1 $2 $3" in',
  '  "config get @insuremo:registry"|"config get registry") printf "%s\\n" "https://public.insuremo.com/artifactory/api/npm/npm/";;',
  '  "view @insuremo/imo version") printf "%s\\n" "0.2.20";;',
  '  "root -g --registry") printf "%s\\n" "/tmp/isolated-npm-root";;',
  '  *) printf "%s\\n" "unsupported read-only npm probe" >&2; exit 1;;',
  'esac',
  '',
].join('\n'), { mode: 0o755 })

const env = {
  ...process.env,
  HOME: home,
  DSH_HOME: join(userData, 'harness'),
  DSH_DESKTOP_TEST_USER_DATA: userData,
  DSH_DESKTOP_TEST_HEADLESS: '1',
  DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS: '300000',
  SMOKE_CANARY: canary,
  SMOKE_NPX_MARKER: marker,
  NO_COLOR: '1',
  NODE_OPTIONS: '',
  npm_config_update_notifier: 'false',
  npm_config_registry: 'http://127.0.0.1:9/',
  npm_config_cache: npmCache,
  npm_config_prefix: npmPrefix,
  npm_config_userconfig: join(smokeRoot, 'npmrc'),
  NPM_CONFIG_USERCONFIG: join(smokeRoot, 'npmrc'),
  XDG_CONFIG_HOME: xdgConfig,
  XDG_CACHE_HOME: xdgCache,
  PATH: [fakeBin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
}
delete env.ELECTRON_RUN_AS_NODE

const result = {
  ok: false,
  appBundle,
  appBinary,
  canary,
  smokeRoot,
  userData,
  home,
  fakeBin,
  environment: {
    registry: env.npm_config_registry,
    cache: npmCache,
    prefix: npmPrefix,
    pathHead: fakeBin,
    externalInstall: false,
    modelRequest: false,
    fakeNpmReadOnly: true,
  },
  expectedWorkbenchSha256,
  errors: [],
  console: [],
  requests: [],
}
let child
let debugPort
let socketSequence = 1
let captureSocket
let captureClosed = false

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise(resolvePromise => server.close(resolvePromise))
  if (port === undefined) throw new Error('unable to allocate a local debug port')
  return port
}

async function targets() {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`${label} timeout${lastError === undefined ? '' : `: ${lastError instanceof Error ? lastError.message : String(lastError)}`}`)
}

async function pageTarget() {
  const list = await targets()
  return list.find(value => value.type === 'page' && typeof value.url === 'string' && value.url.startsWith('http://127.0.0.1:'))
}

async function evaluate(expression) {
  const page = await pageTarget()
  if (page === undefined) throw new Error('harness page unavailable')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.onopen = resolvePromise
    socket.onerror = reject
  })
  const id = socketSequence++
  const response = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP evaluate timeout')), 30_000)
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      resolvePromise(message)
    }
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  try { socket.close() } catch { /* best effort */ }
  if (response.result?.exceptionDetails !== undefined) {
    const detail = response.result.exceptionDetails
    throw new Error(`page evaluation failed: ${detail.exception?.description ?? detail.text ?? 'unknown exception'}`)
  }
  return response.result?.result?.value
}

async function attachCapture() {
  const page = await pageTarget()
  if (page === undefined) throw new Error('harness page unavailable for capture')
  captureSocket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    captureSocket.onopen = resolvePromise
    captureSocket.onerror = reject
  })
  captureSocket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      result.console.push(`EXC ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown exception'}`.slice(0, 800))
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      const args = (message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ')
      result.console.push(`${message.params.type} ${args}`.slice(0, 800))
    }
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request
      if (typeof request?.url === 'string') result.requests.push({ method: request.method, url: request.url })
    }
  }
  captureSocket.send(JSON.stringify({ id: 900, method: 'Runtime.enable' }))
  captureSocket.send(JSON.stringify({ id: 901, method: 'Network.enable' }))
}

async function dismissOnboarding() {
  result.onboarding = []
  for (let step = 0; step < 6; step += 1) {
    const value = await evaluate(`(()=>{
      const d=document.querySelector('[role="dialog"]')
      const buttons=[...(d?.querySelectorAll('button')??[])]
      const b=buttons.find(x=>/稍后配置|later|skip|跳过/i.test((x.textContent||'').trim())) || buttons.find(x=>/继续|Continue/i.test((x.textContent||'').trim()))
      if(!b)return {found:false,dialog:Boolean(d)}
      b.click();return {found:true,text:(b.textContent||'').trim()}
    })()`)
    result.onboarding.push(value)
    if (!value?.found) return
    await sleep(800)
  }
}

async function clickSettings() {
  const clicked = await evaluate(`(()=>{
    const all=[...document.querySelectorAll('button')]
    const label=b=>((b.getAttribute('aria-label')||b.textContent||'').trim())
    const named=all.find(b=>/^(settings|设置)$/i.test(label(b)))
    const fallback=all.find(b=>b.matches('[aria-haspopup="dialog"]') && !/InsureMO/i.test(label(b)))
    const b=named||fallback
    if(!b)return {found:false,buttons:all.slice(0,20).map(x=>({a:x.getAttribute('aria-label'),t:(x.textContent||'').trim().slice(0,60)}))}
    b.click();return {found:true,label:b.getAttribute('aria-label')||'',text:(b.textContent||'').trim().slice(0,80)}
  })()`)
  result.settingsTrigger = clicked
  if (!clicked?.found) throw new Error(`Settings trigger not found: ${JSON.stringify(clicked)}`)
  await waitFor(async () => evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))'), 30_000, 'Settings dialog')
}

async function clickPluginNavigation() {
  const nav = await evaluate(`(()=>{
    const d=document.querySelector('[role="dialog"]');if(!d)return {found:false}
    const b=[...d.querySelectorAll('nav button,button')].find(x=>/插件|Plugins/i.test((x.textContent||'').trim()))
    if(!b)return {found:false,buttons:[...d.querySelectorAll('button')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,30)}
    b.click();return {found:true,text:(b.textContent||'').trim()}
  })()`)
  if (!nav?.found) throw new Error(`Plugins navigation not found: ${JSON.stringify(nav)}`)
  await sleep(1_000)
  const tab = await evaluate(`(()=>{
    const d=document.querySelector('[role="dialog"]');if(!d)return {found:false}
    const b=[...d.querySelectorAll('button')].find(x=>/插件配置|Plugin configuration/i.test((x.textContent||'').trim()))
    if(!b)return {found:false,buttons:[...d.querySelectorAll('button')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,40)}
    b.click();return {found:true,text:(b.textContent||'').trim()}
  })()`)
  if (!tab?.found) throw new Error(`Plugin configuration tab not found: ${JSON.stringify(tab)}`)
}

async function expandCard() {
  const card = await waitFor(async () => evaluate(`(()=>{
    const d=document.querySelector('[role="dialog"]');if(!d)return null
    const b=[...d.querySelectorAll('button')].find(x=>/InsureMO/i.test(x.getAttribute('aria-label')||'') || /InsureMO Overview/i.test((x.textContent||'')))
    return b?{found:true,label:b.getAttribute('aria-label')||'',expanded:b.getAttribute('aria-expanded')}:null
  })`), 30_000, 'InsureMO card')
  await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');const b=[...d.querySelectorAll('button')].find(x=>/InsureMO/i.test(x.getAttribute('aria-label')||'') || /InsureMO Overview/i.test((x.textContent||'')));if(!b)return false;if(b.getAttribute('aria-expanded')!=='true')b.click();return true})()`)
  await sleep(3_000)
  return { ...card, after: await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');return {text:(d?.innerText||'').slice(0,4000),scenarios:[...document.querySelectorAll('[data-scenario]')].map(x=>x.getAttribute('data-scenario')),buttons:[...(d?.querySelectorAll('button')??[])].map(x=>({a:x.getAttribute('aria-label'),t:(x.textContent||'').trim().slice(0,100)})).slice(-60)}})()`) }
}

async function triggerInstallFailure() {
  const clicked = await waitFor(async () => {
    const value = await evaluate(`(()=>{
      const d=document.querySelector('[role="dialog"]');if(!d)return {found:false}
      const b=[...d.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').trim().startsWith('Install: icomposer-full-stack') || /安装[:：]\\s*icomposer-full-stack|Install[:：]\\s*icomposer-full-stack/i.test((x.textContent||'').trim()))
      if(!b)return {found:false}
      b.click();return {found:true,label:b.getAttribute('aria-label')||'',text:(b.textContent||'').trim()}
    })()`)
    return value?.found ? value : undefined
  }, 120_000, 'scenario install button')
  await waitFor(async () => existsSync(marker) && readFileSync(marker, 'utf8').includes(canary), 120_000, 'fake npx invocation')
  const failed = await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-scenario="failed"]'))`), 120_000, 'failed scenario state')
  return { clicked, failed }
}

async function clickDiagnose() {
  return await waitFor(async () => {
    const value = await evaluate(`(()=>{
      const d=document.querySelector('[role="dialog"]');const p=d?.querySelector('[data-scenario="failed"]');if(!p)return null
      let node=p
      for(let i=0;i<8&&node;i++,node=node.parentElement){
        const b=[...node.querySelectorAll('button')].find(x=>/诊断|Diagnose/i.test((x.textContent||'').trim()))
        if(b){b.click();return {found:true,text:(b.textContent||'').trim()}}
      }
      return {found:false}
    })()`)
    return value?.found ? value : undefined
  }, 30_000, 'diagnose button')
}

async function readComposer() {
  return await evaluate(`(()=>{
    const areas=[...document.querySelectorAll('textarea')]
    const f=areas.find(x=>(x.value||'').includes(${JSON.stringify(canary)})) || areas.find(x=>(x.value||'').length>500)
    if(!f)return null
    return {value:f.value,len:f.value.length,disabled:f.disabled,readOnly:f.readOnly,placeholder:f.getAttribute('placeholder')||''}
  })()`)
}

async function readModelSeat() {
  return await evaluate(`(()=>{
    const b=[...document.querySelectorAll('button[aria-haspopup="menu"]')].find(x=>/^(选择模型|Select model)(?:[，,]|$)/i.test((x.getAttribute('aria-label')||'').trim()))
    if(!b)return {found:false,candidates:[...document.querySelectorAll('button[aria-haspopup="menu"]')].map(x=>({label:x.getAttribute('aria-label'),disabled:x.disabled})).slice(0,20)}
    return {found:true,label:b.getAttribute('aria-label')||'',disabled:b.disabled,expanded:b.getAttribute('aria-expanded')||'false',title:b.getAttribute('title')||''}
  })()`)
}

function workspaceEvidence() {
  const path = join(userData, 'harness/storages/workspace.json')
  if (!existsSync(path)) return { path, exists: false, count: 0, workspaces: [] }
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const workspaces = Object.values(data.tables?.workspaces ?? {}).filter(value => String(value?.path ?? '').includes('install-diagnostics'))
  return { path, exists: true, count: workspaces.length, workspaces }
}

function runtimeEvidence() {
  const contents = dirname(dirname(appBinary))
  const resources = join(contents, 'Resources')
  const manifestPath = join(resources, 'dsh-runtime/manifest.json')
  const compatibilityPath = join(resources, 'app/compatibility.json')
  if (!existsSync(manifestPath)) return { manifestPath, present: false }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundled = join(resources, 'dsh-runtime', manifest.workbench.path)
  const installed = join(userData, 'harness/profiles/web/node_modules/@icomposer/workbench/lib/client.js')
  const tarClient = (() => {
    try {
      return Buffer.from(execFileSync('tar', ['-xOf', bundled, 'package/lib/client.js']))
    } catch { return undefined }
  })()
  const compatibility = existsSync(compatibilityPath) ? JSON.parse(readFileSync(compatibilityPath, 'utf8')) : undefined
  return {
    present: true,
    manifestPath,
    manifestSha256: digest(readFileSync(manifestPath)),
    runtimeVersion: manifest.runtimeVersion,
    nodeVersion: manifest.nodeVersion,
    runtimeArch: manifest.runtimeArch,
    nodeMode: manifest.nodeMode,
    workbench: {
      path: bundled,
      sha256: manifest.workbench.sha256,
      bytes: existsSync(bundled) ? readFileSync(bundled).byteLength : 0,
      actualSha256: existsSync(bundled) ? digest(readFileSync(bundled)) : null,
    },
    compatibility: compatibility?.workbench?.sha256 ?? null,
    installedClientSha256: existsSync(installed) ? digest(readFileSync(installed)) : null,
    tarClientSha256: tarClient === undefined ? null : digest(tarClient),
  }
}

async function servedClientEvidence() {
  return await evaluate(`(async()=>{
    const seen=performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('/plugins/@icomposer/workbench/client.js'))
    const url=seen||'/plugins/@icomposer/workbench/client.js'
    const response=await fetch(url);const bytes=new Uint8Array(await response.arrayBuffer());const hash=await crypto.subtle.digest('SHA-256',bytes)
    return {present:true,url,status:response.status,bytes:bytes.byteLength,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}
  })()`)
}

async function terminate() {
  if (captureSocket !== undefined && !captureClosed) {
    captureClosed = true
    try { captureSocket.close() } catch { /* best effort */ }
  }
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    sleep(10_000).then(() => undefined),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

try {
  if (!existsSync(appBinary)) throw new Error(`packaged app binary missing: ${appBinary}`)
  debugPort = await freePort()
  const logFd = openSync(logPath, 'w')
  child = spawn(appBinary, ['--no-sandbox', `--remote-debugging-port=${debugPort}`], {
    cwd: root,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  child.once('close', () => { try { closeSync(logFd) } catch { /* already closed */ } })
  await waitFor(pageTarget, 120_000, 'packaged Harness page')
  await attachCapture()
  result.boot = await waitFor(async () => evaluate(`(()=>{
    const body=(document.body?.innerText||'')
    const buttons=[...document.querySelectorAll('button')]
    const hasTrigger=buttons.some(b=>b.matches('[aria-haspopup="dialog"]') || /settings|设置/i.test((b.getAttribute('aria-label')||'')+' '+(b.textContent||'')))
    return {title:document.title,body:body.slice(0,300),bodyLength:body.length,hasSettingsTrigger:hasTrigger}
  })()`).then(value => value?.hasSettingsTrigger && (value.bodyLength ?? 0) > 20 ? value : undefined), 180_000, 'packaged Harness boot')
  result.settings = {}
  await dismissOnboarding()
  await clickSettings()
  result.settings.dialog = true
  result.settings.navigation = await clickPluginNavigation()
  result.afterPluginNavigation = await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');return {text:(d?.innerText||'').slice(0,2500),buttons:[...(d?.querySelectorAll('button')??[])].map(b=>({a:b.getAttribute('aria-label'),e:b.getAttribute('aria-expanded'),t:(b.textContent||'').trim().slice(0,120)})).slice(0,80)}})()`)
  result.card = await expandCard()
  result.install = await triggerInstallFailure()
  result.diagnose = await clickDiagnose()
  result.workspace = await waitFor(async () => {
    const evidence = workspaceEvidence()
    return evidence.count === 1 ? evidence : undefined
  }, 30_000, 'dedicated diagnosis workspace')
  result.composer = await waitFor(readComposer, 30_000, 'prefilled editable composer')
  if (result.composer.disabled || result.composer.readOnly || !result.composer.value.includes(canary)) throw new Error('diagnosis composer is not editable and canary-prefilled')
  result.modelSeat = await waitFor(async () => {
    const value = await readModelSeat()
    return value?.found ? value : undefined
  }, 30_000, 'model selection entry')
  if (result.modelSeat.disabled) throw new Error('model selection entry is disabled')
  const beforeLength = result.composer.value.length
  await sleep(3_000)
  result.composerAfterDelay = await readComposer()
  result.noAutoSend = result.composerAfterDelay?.len === beforeLength && result.composerAfterDelay?.value.includes(canary) === true
  if (!result.noAutoSend) throw new Error('diagnosis draft disappeared or changed without a manual send')
  result.modelRequests = result.requests.filter(request => /(?:\/prompt(?:\/|\?|$)|\/message(?:\/|\?|$)|\/completion(?:\/|\?|$)|\/chat(?:\/|\?|$))/iu.test(request.url))
  if (result.modelRequests.length > 0) throw new Error(`unexpected model/prompt request: ${JSON.stringify(result.modelRequests)}`)
  result.runtime = runtimeEvidence()
  result.served = await servedClientEvidence()
  result.fakeNpxRuns = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split(/\r?\n/u).filter(Boolean).length : 0
  if (result.fakeNpxRuns !== 1) throw new Error(`fake npx invocation count was ${result.fakeNpxRuns}, expected 1`)
  if (result.runtime.workbench.sha256 !== expectedWorkbenchSha256 || result.runtime.workbench.actualSha256 !== expectedWorkbenchSha256) throw new Error('embedded Workbench tgz hash does not match expected verified artifact')
  if (result.runtime.compatibility !== expectedWorkbenchSha256) throw new Error('packaged compatibility mapping does not match Workbench hash')
  if (result.runtime.installedClientSha256 === null || result.runtime.tarClientSha256 === null || result.runtime.installedClientSha256 !== result.runtime.tarClientSha256) throw new Error('installed Workbench client does not match tar client')
  if (result.served.sha256 !== result.runtime.installedClientSha256) throw new Error('served Workbench client does not match installed client')
  if (result.served.status !== 200) throw new Error(`served Workbench client status was ${result.served.status}`)
  if (result.console.length > 0) throw new Error(`packaged diagnosis console errors: ${JSON.stringify(result.console)}`)
  result.ok = true
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await terminate()
  result.exit = child === undefined ? null : { code: child.exitCode, signal: child.signalCode }
  try { writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n') } catch (error) { result.errors.push(`write result failed: ${String(error)}`) }
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
