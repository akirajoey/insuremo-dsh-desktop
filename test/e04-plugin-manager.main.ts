import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { ProfileManager } from '../src/main/profile/profile-manager.ts'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher.ts'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler.ts'
import { PluginService } from '../src/main/plugins/plugin-service.ts'
import { createPluginManagerWindow } from '../src/main/windows/plugin-manager-window.ts'

const TEST_TGZ = '/tmp/e04-test-plugin.tgz'
const WORKBENCH_TGZ = '/Users/junjie.zhang/dsh/icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz'
const WB_SHA = 'b1019017b79782a97b0b980268c2250384446ae5bbed8cb62af41c0754bdc59f'
const PNPM = '/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs'
const NODE = '/opt/homebrew/bin/node'
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e04-win-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
let result = { ok: false, detail: '' }

app.setPath('userData', userData)
// Keep the app alive across destroy/reopen probes (default would quit when
// every window is closed).
app.on('window-all-closed', () => { /* no-op for test */ })

async function seedWorkbench() {
  const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: WORKBENCH_TGZ, workbenchSha256: WB_SHA })
  const cached = pm.ensureWorkbenchArtifact()
  const staging = pm.materializeStagingProfile('seed')
  const r = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 180_000 }, 'add', ['--save-exact', `file:${cached}`])
  if (r.exitCode !== 0) throw new Error(`seed pnpm: ${r.stderr}`)
  BundleReconciler.reconcile(staging)
  pm.activateStagedProfile(staging, 'seed')
  return pm
}

async function run() {
  const pm = await seedWorkbench()
  const service = new PluginService({ profileManager: pm, capabilityDir: join(userData, 'caps'), pnpmEntry: PNPM, nodePath: NODE, workbenchName: '@icomposer/workbench' })
  service.registerCapability('win-cap', TEST_TGZ)

  // Simulate the capability install the window would trigger.
  const install = await service.runOperation('add', 'tgz:win-cap', 'tgz:win-cap')
  if (!install.ok) throw new Error(`install: ${install.message}`)

  // Open the real Plugin Manager window (file:// with the dedicated preload
  // and capability-gated IPC registration).
  const window = createPluginManagerWindow(service)

  // The preload exposes the typed API; list must include the test plugin.
  const listed = await window.webContents.executeJavaScript('window.insuremoPlugins.list()')
  const hasTest = Array.isArray(listed) && listed.some((p: { name: string }) => p.name === '@icomposer/test-plugin')
  if (!hasTest) throw new Error(`test plugin not listed: ${JSON.stringify(listed)}`)

  // Remove through the real preload API.
  const removed = await window.webContents.executeJavaScript('window.insuremoPlugins.remove("@icomposer/test-plugin")')
  if (removed.ok !== true) throw new Error(`remove failed: ${removed.message}`)
  await new Promise(r => setTimeout(r, 800))
  const listed2 = await window.webContents.executeJavaScript('window.insuremoPlugins.list()')
  const stillThere = Array.isArray(listed2) && listed2.some((p: { name: string }) => p.name === '@icomposer/test-plugin')
  if (stillThere) throw new Error('test plugin still listed after remove')

  // Security boundary: a non-plugin-manager window must be forbidden.
  const harnessLike = new BrowserWindow({
    webPreferences: { preload: join(PROJECT_ROOT, 'out/preload/plugin-manager.cjs'), sandbox: true, contextIsolation: true },
  })
  await harnessLike.loadFile(join(PROJECT_ROOT, 'out/renderer/index.html'))
  let forbidden = false
  try {
    await harnessLike.webContents.executeJavaScript('window.insuremoPlugins.list()')
  } catch {
    forbidden = true
  }
  harnessLike.destroy()
  if (!forbidden) throw new Error('non-manager window was not forbidden')

  result = { ok: true, detail: JSON.stringify({ install: install.ok, listedBefore: hasTest, removedOk: removed.ok, goneAfter: !stillThere, forbidden }) }
  window.destroy()
  await new Promise(r => setTimeout(r, 500))

  // Reopen the Plugin Manager window: IPC handlers must not double-register
  // and list must keep working.
  const reopened = createPluginManagerWindow(service)
  await new Promise(r => setTimeout(r, 1200))
  const listedReopen = await reopened.webContents.executeJavaScript('window.insuremoPlugins.list()')
  if (!Array.isArray(listedReopen)) throw new Error('reopen list failed')
  // Capability one-time semantics: replaying the consumed capability fails.
  const replay = await service.runOperation('add', 'tgz:win-cap', 'tgz:win-cap')
  if (replay.ok !== false) throw new Error('capability replay was not rejected')
  result = { ok: true, detail: JSON.stringify({ install: install.ok, listedBefore: hasTest, removedOk: removed.ok, goneAfter: !stillThere, reopenListOk: Array.isArray(listedReopen), replayRejected: replay.ok === false }) }
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    result = { ok: false, detail: String(error) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    writeFileSync('/tmp/e04-window-result.json', JSON.stringify(result))
    console.log('E04_WINDOW_RESULT', JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  }
})
