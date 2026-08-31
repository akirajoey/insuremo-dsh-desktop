import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher.ts'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler.ts'
import { ProfileManager } from '../src/main/profile/profile-manager.ts'
import { RuntimeController } from '../src/main/runtime/controller.ts'
import { forkUtilityProcess } from '../src/main/runtime/utility-launcher.ts'
import { parseHandshake } from '../src/main/runtime/launcher.ts'
import { WORKBENCH_TGZ as TGZ, WORKBENCH_SHA256 as SHA } from './support/workbench.ts'
import { resolvePnpmEntry as resolveTestPnpmEntry } from '../scripts/resolve-pnpm-entry.mjs'

const PNPM = resolveTestPnpmEntry()
const NODE = process.execPath
const WRAPPER = fileURLToPath(new URL('../src/main/runtime/wrapper.cjs', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e03-window-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DSH_HOME: dshHome, NO_COLOR: '1' }
let result = { ok: false, detail: '' }

app.setPath('userData', userData)

async function installWorkbench() {
  const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: TGZ, workbenchSha256: SHA })
  const cached = pm.ensureWorkbenchArtifact()
  const staging = pm.materializeStagingProfile('window')
  const r = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 180_000 }, 'add', ['--save-exact', `file:${cached}`])
  if (r.exitCode !== 0) throw new Error(`pnpm add: ${r.stderr}`)
  BundleReconciler.reconcile(staging)
  pm.activateStagedProfile(staging, 'window')
}

async function run() {
  await installWorkbench()
  const child = forkUtilityProcess({ launchId: 'e03-window', dshHome, wrapperPath: WRAPPER, cwd: process.cwd(), env })
  let stderr = ''
  child.onStderr(chunk => { stderr += chunk.toString('utf8') })
  const handshake = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`handshake timeout: ${stderr.slice(-800)}`)), 60_000)
    child.onMessage(message => {
      const parsed = parseHandshake(message)
      if (parsed !== undefined) { clearTimeout(timer); resolve(parsed) }
    })
    child.onExit(code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${stderr.slice(-800)}`)) })
  })
  const url = `http://127.0.0.1:${(handshake as { port: number }).port}`
  const window = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  await window.loadURL(url)
  await new Promise(r => setTimeout(r, 4000))
  // Dismiss the onboarding overlays so the real Workbench surface renders.
  await window.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const cont = btns.find(b => /继续/.test(b.innerText)); if (cont) cont.click();
  })()`)
  await new Promise(r => setTimeout(r, 1500))
  await window.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const later = btns.find(b => /稍后配置/.test(b.innerText)); if (later) later.click();
  })()`)
  await new Promise(r => setTimeout(r, 5000))

  // Strict DOM feature assertion: the workbench BrandChrome must render a
  // visible wordmark image (non-zero rect) from the host brand-assets route,
  // and the host route must serve 200. This fails explicitly when absent.
  const probe = await window.webContents.executeJavaScript(`(() => {
    const wm = [...document.querySelectorAll('img')].filter(i => /wordmark/.test(i.src));
    const visible = wm.map(i => { const r = i.getBoundingClientRect(); return { src: i.src, w: r.width, h: r.height, x: r.x, y: r.y }; })
      .filter(v => v.w > 0 && v.h > 0);
    return {
      title: document.title,
      visibleWordmarks: visible,
      hasVisibleBrand: visible.length > 0,
      textLen: (document.body.innerText || '').length,
    };
  })()`)

  // Host-level evidence: the workbench brand-assets route must actually serve.
  let brandAssetStatus = 0
  let brandAssetBytes = 0
  try {
    const assetResponse = await fetch(`${url}/api/icomposer-workbench/ui/assets/insuremo-globe.png`)
    brandAssetStatus = assetResponse.status
    brandAssetBytes = (await assetResponse.arrayBuffer()).byteLength
  } catch {
    brandAssetStatus = 0
  }

  if (!probe.hasVisibleBrand || brandAssetStatus !== 200) {
    throw new Error(`E03 DOM feature assertion failed: no visible workbench brand. probe=${JSON.stringify(probe)} brandAsset=${brandAssetStatus}/${brandAssetBytes}`)
  }
  result = { ok: true, detail: JSON.stringify({ probe, brandAssetStatus, brandAssetBytes }) }
  child.post({ type: 'shutdown', requestId: 'e03-window-shutdown' })
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 10_000)
    child.onExit(() => { clearTimeout(timer); resolve() })
  })
  window.destroy()
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    result = { ok: false, detail: String(error) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    console.log('E03_WINDOW_RESULT', JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  }
})
