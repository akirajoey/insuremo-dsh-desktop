import { mkdtempSync, rmSync, existsSync, renameSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { ProfileManager } from '../src/main/profile/profile-manager.ts'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher.ts'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler.ts'
import { PluginService } from '../src/main/plugins/plugin-service.ts'
import { HarnessManager } from '../src/main/app/harness-manager.ts'
import { DiagnosticsService } from '../src/main/app/diagnostics.ts'
import { WindowStateStore } from '../src/main/app/window-state.ts'
import { createHarnessWindow } from '../src/main/windows/harness-window.ts'
import { createFailureWindow } from '../src/main/windows/failure-window.ts'
import { WORKBENCH_TGZ, WORKBENCH_SHA256 as WB_SHA } from './support/workbench.ts'

const PNPM = '/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs'
const NODE = '/opt/homebrew/bin/node'
const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e05e06-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
let result = { ok: false, detail: '' }

app.setPath('userData', userData)
app.on('window-all-closed', () => { /* keep alive across probes */ })

async function step(name: string, action: () => Promise<string>): Promise<void> {
  const detail = await action()
  console.log(`[e05e06] ${name}: ${detail}`)
}

async function seedWorkbench(pm: ProfileManager): Promise<void> {
  const cached = pm.ensureWorkbenchArtifact()
  const staging = pm.materializeStagingProfile('seed')
  const r = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 240_000 }, 'add', ['--save-exact', `file:${cached}`])
  if (r.exitCode !== 0) throw new Error(`seed pnpm: ${r.stderr.slice(-500)}`)
  BundleReconciler.reconcile(staging)
  pm.activateStagedProfile(staging, 'seed')
}

function manifestOf(home: string): { dependencies: Record<string, string>; bundles: string[] } {
  const manifest = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  return { dependencies: manifest.dependencies ?? {}, bundles: manifest.dsh?.profile?.bundles ?? [] }
}

function makeThrowingPlugin(): string {
  const sourceRoot = join(tmp, 'throw-plugin-source')
  const packageDir = join(sourceRoot, 'package')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@icomposer/throw-plugin',
    version: '0.1.0',
    type: 'module',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [] } },
  }))
  writeFileSync(join(packageDir, 'lib/index.js'), 'throw new Error("E06 intentional plugin import failure")\\n')
  writeFileSync(join(packageDir, 'cordis.patch.yml'), "- insert:\\n    - id: throw-plugin-probe\\n      name: '@icomposer/throw-plugin'\\n      inject: []\\n")
  const archive = join(tmp, 'throw-plugin.tgz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', sourceRoot, 'package'], { stdio: 'ignore' })
  return archive
}

async function run(): Promise<void> {
  const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: WORKBENCH_TGZ, workbenchSha256: WB_SHA })
  const plugins = new PluginService({ profileManager: pm, capabilityDir: join(userData, 'caps'), pnpmEntry: PNPM, nodePath: NODE, workbenchName: '@icomposer/workbench' })
  const diagnostics = new DiagnosticsService(pm, userData)
  const harness = new HarnessManager({ userData, profileManager: pm, runtimePin: '0.1.0-rc.7', pnpmEntry: PNPM, nodePath: NODE })
  const windowState = new WindowStateStore(userData)

  await step('seed', async () => {
    await seedWorkbench(pm)
    return `bundles=${manifestOf(dshHome).bundles.join(',')}`
  })

  let window: BrowserWindow | undefined
  await step('normal-boot', async () => {
    const snapshot = await harness.start('normal')
    if (snapshot.phase !== 'ready' || snapshot.url === undefined) throw new Error(`normal boot: ${snapshot.message}`)
    window = createHarnessWindow({ url: snapshot.url, windowState, safeMode: false })
    await new Promise(r => setTimeout(r, 1500))
    if (!window.webContents.getURL().startsWith('http://127.0.0.1:')) throw new Error(`harness window url: ${window.webContents.getURL()}`)
    return `title=${window.getTitle()} url=${window.webContents.getURL()}`
  })

  await step('window-state-persisted', async () => {
    window?.close()
    await new Promise(r => setTimeout(r, 500))
    if (!existsSync(join(userData, 'desktop-state', 'window-state.json'))) throw new Error('window state not saved on close')
    return 'saved'
  })

  await step('restart-harness', async () => {
    const snapshot = await harness.restart('normal')
    if (snapshot.phase !== 'ready') throw new Error(`restart: ${snapshot.message}`)
    return `restarted port=${new URL(snapshot.url as string).port}`
  })

  await step('safe-mode', async () => {
    const before = manifestOf(dshHome)
    const snapshot = await harness.start('safe')
    if (snapshot.phase !== 'ready' || snapshot.url === undefined) throw new Error(`safe boot: ${snapshot.message}`)
    const after = manifestOf(dshHome)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('normal home mutated by safe mode')
    const safeManifest = manifestOf(join(userData, 'safe-runtime/harness'))
    if (safeManifest.dependencies['@icomposer/workbench'] !== undefined) throw new Error('safe home contains workbench')
    if (!safeManifest.bundles.includes('@deepseek-ai/dsh-base') || !safeManifest.bundles.includes('@deepseek-ai/dsh-web-app')) throw new Error('safe home bundles wrong')
    const safeWindow = createHarnessWindow({ url: snapshot.url, windowState, safeMode: true })
    await new Promise(r => setTimeout(r, 1500))
    if (!safeWindow.getTitle().includes('Safe Mode')) throw new Error(`safe title: ${safeWindow.getTitle()}`)
    safeWindow.destroy()
    return `safe bundles=${safeManifest.bundles.join(',')}`
  })

  let failurePayload: Awaited<ReturnType<DiagnosticsService['collect']>> | undefined
  await step('failure-diagnostics', async () => {
    const snapshot = await harness.start('normal')
    if (snapshot.phase !== 'ready') throw new Error(`post-safe normal boot: ${snapshot.message}`)
    renameSync(join(dshHome, 'profiles/web/node_modules'), join(dshHome, 'profiles/web/node_modules.bak'))
    const failed = await harness.start('normal')
    if (failed.phase !== 'failed') throw new Error(`expected failed boot, got ${failed.phase}`)
    failurePayload = diagnostics.collect({ mode: 'normal', phase: failed.phase, message: failed.message, stderrTail: failed.message })
    if (!failurePayload.profile.missingModules.includes('@icomposer/workbench')) {
      throw new Error(`missing modules not detected: ${JSON.stringify(failurePayload.profile.missingModules)}`)
    }
    return `missing=${failurePayload.profile.missingModules.join(',')}`
  })

  await step('rebuild-recovery', async () => {
    const rebuild = await plugins.rebuild()
    if (!rebuild.ok) throw new Error(`rebuild: ${rebuild.message}`)
    if (!existsSync(join(dshHome, 'profiles/web/node_modules/@icomposer/workbench/package.json'))) throw new Error('workbench not reinstalled')
    const snapshot = await harness.start('normal')
    if (snapshot.phase !== 'ready') throw new Error(`post-rebuild boot: ${snapshot.message}`)
    return 'rebuilt and booted'
  })

  await step('import-throw-failure-page', async () => {
    const archive = makeThrowingPlugin()
    plugins.registerCapability('throw-cap', archive)
    const install = await plugins.runOperation('add', 'tgz:throw-cap', 'tgz:throw-cap')
    if (!install.ok) throw new Error(`throwing plugin install: ${install.message}`)
    const failed = await harness.start('normal')
    if (failed.phase !== 'failed') throw new Error(`expected import failure, got ${failed.phase}`)
    const context = { mode: 'normal' as const, phase: failed.phase, message: failed.message, stderrTail: failed.message, profileHome: dshHome }
    const failureWindow = createFailureWindow({
      harness,
      plugins,
      profileManager: pm,
      diagnostics,
      userData,
      lastContext: () => context,
      onRestart: async () => {
        const snapshot = await harness.restart('normal')
        return { ok: snapshot.phase === 'ready', message: snapshot.message }
      },
      onSafeMode: async () => {
        const snapshot = await harness.start('safe')
        return { ok: snapshot.phase === 'ready', message: snapshot.message }
      },
      onSelectRuntime: async () => ({ ok: false, message: 'not available in this probe' }),
    })
    await new Promise(r => setTimeout(r, 1_200))
    const payload = await failureWindow.webContents.executeJavaScript('window.insuremoFailure.diagnostics()') as { profile: { bundles: string[]; missingModules: string[] }; message: string; stderrTail?: string; logTail?: string }
    if (!payload.profile.bundles.includes('@icomposer/throw-plugin')) throw new Error('failure page omitted throwing plugin')
    if (payload.message === '' && (payload.stderrTail ?? '') === '' && (payload.logTail ?? '') === '') throw new Error('failure page omitted local failure diagnostics')

    // Auto-accept only this test's native confirmation; production always
    // presents the warning dialog before removal.
    const originalMessageBox = dialog.showMessageBox
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    let removed: { ok: boolean; message: string }
    try {
      removed = await failureWindow.webContents.executeJavaScript('window.insuremoFailure.removePlugin("@icomposer/throw-plugin")') as { ok: boolean; message: string }
    } finally {
      dialog.showMessageBox = originalMessageBox
    }
    if (!removed.ok) throw new Error(`failure-page remove: ${removed.message}`)
    failureWindow.destroy()
    const recovered = await harness.start('normal')
    if (recovered.phase !== 'ready') throw new Error(`post-remove boot: ${recovered.message}`)
    const manifest = manifestOf(dshHome)
    if (manifest.bundles.includes('@icomposer/throw-plugin')) throw new Error('removed plugin still in bundles')
    return `failure page diagnostics+remove recovered=${recovered.phase}`
  })

  await step('quit-cleanup', async () => {
    await harness.stop()
    if (existsSync(join(userData, 'desktop-state', 'runtime-owner.json'))) throw new Error('ownership record left behind')
    return 'no resident runtime'
  })

  result = { ok: true, detail: 'all E05/E06 steps passed' }
}

const kill = setTimeout(() => {
  result = { ok: false, detail: 'global timeout' }
  rmSync(tmp, { recursive: true, force: true })
  console.log('E05E06_RESULT', JSON.stringify(result))
  app.exit(1)
}, 420_000)

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    result = { ok: false, detail: String(error) }
  } finally {
    clearTimeout(kill)
    rmSync(tmp, { recursive: true, force: true })
    writeFileSync('/tmp/e05e06-result.json', JSON.stringify(result))
    console.log('E05E06_RESULT', JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  }
})
