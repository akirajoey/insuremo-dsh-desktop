import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ABOUT_CAPABILITY,
  authorizeIpc,
} from './security/policy.ts'
import {
  createAboutWindow,
  getAboutUrl,
  getAboutWindow,
} from './windows/about-window.ts'
import { getPluginManagerWindow, createPluginManagerWindow } from './windows/plugin-manager-window.ts'
import { createHarnessWindow, harnessThemeBackground } from './windows/harness-window.ts'
import { createFailureWindow, getFailureWindow, type FailureWindowDeps } from './windows/failure-window.ts'
import { ProfileManager } from './profile/profile-manager.ts'
import { PluginService } from './plugins/plugin-service.ts'
import { WindowStateStore } from './app/window-state.ts'
import { HarnessManager, readRuntimePin } from './app/harness-manager.ts'
import { DiagnosticsService, type DiagnosticsContext } from './app/diagnostics.ts'
import { installApplicationMenu, dockIconPath } from './app/menu.ts'
import { createBootQueue, resolveActivation } from './app/window-activation.ts'
import { resolveNodePath, resolvePnpmEntry } from './app/runtime-paths.ts'
import {
  readPackagedVariant,
  runtimeStatus,
  verifyPackagedRuntime,
  verifyRuntimeRoot,
  writeRuntimeSourceConfig,
  type PackagedVariant,
  type RuntimeResourceLayout,
  type RuntimeSourceStatus,
} from './app/runtime-resources.ts'
import { UpgradeManager } from './upgrade/upgrade-manager.ts'
import { captureDesktopEnvironment } from './app/windows-environment.ts'

const safeModeArg = process.argv.includes('--safe-mode') || process.env.DSH_DESKTOP_SAFE_MODE === '1'

function configureUserData(): void {
  const testOverride = process.env.DSH_DESKTOP_TEST_USER_DATA
  if (testOverride !== undefined && testOverride !== '') {
    // app.setPath controls app APIs, while Chromium helper processes inherit
    // their own switch. Set both before readiness so isolated packaged smoke
    // cannot create GPU/network/renderer state in the operator's userData.
    app.commandLine.appendSwitch('user-data-dir', testOverride)
    app.setPath('userData', testOverride)
    return
  }
  if (app.isPackaged) return
  app.setPath('userData', join(app.getPath('appData'), 'insuremo-dsh-desktop-dev'))
}

function registerIpc(): void {
  ipcMain.handle('app:version', (event) => {
    const window = getAboutWindow()
    const frame = event.senderFrame
    const authorized = window !== undefined && frame !== null && authorizeIpc({
      sender: event.sender,
      expectedSender: window.webContents,
      senderFrame: frame,
      mainFrame: event.sender.mainFrame,
      frameUrl: frame.url,
      expectedUrl: getAboutUrl(),
      capability: ABOUT_CAPABILITY,
      expectedCapability: ABOUT_CAPABILITY,
      destroyed: window.isDestroyed(),
    })
    if (!authorized) throw new Error('forbidden')
    return app.getVersion()
  })
}

interface DesktopServices {
  pm: ProfileManager
  plugins: PluginService
  pnpmEntry: string
  nodePath: string
  supervisorPath?: string
  environment: Record<string, string>
  runAsNode: boolean
}

function createServices(runtime: RuntimeResourceLayout | undefined, allowMissingRuntime = false): DesktopServices {
  const userData = app.getPath('userData')
  const dshHome = join(userData, 'harness')
  const environment = captureDesktopEnvironment()
  const runAsNode = runtime?.nodeMode === 'electron-run-as-node' || (app.isPackaged && process.platform === 'darwin' && environment.DSH_DESKTOP_EXPERIMENT_ELECTRON_NODE === '1')
  const pnpmEntry = runtime?.pnpmEntry ?? (allowMissingRuntime ? '' : resolvePnpmEntry(environment))
  const nodePath = runtime?.nodePath ?? (allowMissingRuntime ? process.execPath : resolveNodePath(environment))
  const pm = new ProfileManager({
    userData,
    dshHome,
    runtimeAnchor: runtime?.harnessRoot,
    pnpmEntry,
    nodePath,
    workbenchTgzPath: runtime?.workbenchTgz ?? '',
    workbenchSha256: runtime?.workbenchSha256 ?? '',
    runAsNode,
  })
  const plugins = new PluginService({
    profileManager: pm,
    capabilityDir: join(userData, 'desktop-state', 'plugin-capabilities'),
    pnpmEntry,
    nodePath,
    environment,
    runAsNode,
    workbenchName: '@icomposer/workbench',
  })
  return { pm, plugins, pnpmEntry, nodePath, supervisorPath: runtime?.supervisorPath, environment, runAsNode }
}

let quitting = false

function bootstrap(): void {
  configureUserData()
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.setName('InsureMO DSH Desktop')
  const userData = app.getPath('userData')
  // Follow the system theme; the harness chrome itself stays its own brand.
  nativeTheme.themeSource = 'system'
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(harnessThemeBackground())
    }
  })
  if (process.platform === 'win32') app.setAppUserModelId('com.insuremo.dsh.desktop')
  if (process.platform === 'darwin') {
    const icon = dockIconPath()
    if (existsSync(icon) && app.dock !== undefined) app.dock.setIcon(icon)
  }
  const testOpenPluginManager = process.env.DSH_DESKTOP_TEST_OPEN_PLUGIN_MANAGER === '1'
  let runtimeVariant: PackagedVariant = 'full'
  let runtime: RuntimeResourceLayout | undefined
  let runtimeError: unknown
  if (app.isPackaged) {
    try {
      runtimeVariant = readPackagedVariant()
      runtime = verifyPackagedRuntime()
    } catch (error) {
      runtimeError = error
    }
  }
  let services = createServices(runtime, runtimeError !== undefined)
  let { pm, plugins, pnpmEntry, nodePath, supervisorPath, environment, runAsNode } = services
  let runtimeState: RuntimeSourceStatus = runtimeStatus(runtimeVariant, runtime, runtimeError)
  const testPluginTgz = process.env.DSH_DESKTOP_TEST_PLUGIN_TGZ
  const registerTestPlugin = (): void => {
    if (process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && testPluginTgz !== undefined && testPluginTgz !== '') {
      plugins.registerCapability('packaged-smoke', testPluginTgz)
    }
  }
  registerTestPlugin()
  let upgrades = new UpgradeManager({ userData, appPath: app.getAppPath(), profileManager: pm })
  upgrades.validateCompatibility()
  const testAutoQuitMs = Number(process.env.DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS)
  if (process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && Number.isFinite(testAutoQuitMs) && testAutoQuitMs > 0) {
    setTimeout(() => app.quit(), testAutoQuitMs)
  }
  const makeHarness = (): HarnessManager => new HarnessManager({
    userData,
    profileManager: pm,
    runtimePin: readRuntimePin(join(app.getAppPath())),
    pnpmEntry,
    nodePath,
    environment,
    runAsNode,
    forkMode: app.isPackaged ? 'fork' : 'utility',
    execPath: app.isPackaged ? nodePath : undefined,
    supervisorPath,
    runtimeRoot: runtime?.root,
  })
  let harness = makeHarness()
  const windowState = new WindowStateStore(userData)
  let diagnostics = new DiagnosticsService(pm, userData, () => runtimeState)
  let lastContext: DiagnosticsContext = {
    mode: safeModeArg ? 'safe' : 'normal',
    phase: runtimeError === undefined ? 'starting' : 'failed',
    message: runtimeError instanceof Error ? runtimeError.message : runtimeError === undefined ? '' : String(runtimeError),
    stderrTail: '',
    profileHome: safeModeArg ? join(userData, 'safe-runtime/harness') : join(userData, 'harness'),
  }

  const harnessWindows = new Set<Electron.BrowserWindow>()
  const closeHarnessWindows = (): void => {
    for (const window of harnessWindows) {
      if (!window.isDestroyed()) window.destroy()
    }
    harnessWindows.clear()
  }

  const openHarness = (mode: 'normal' | 'safe'): Electron.BrowserWindow => {
    const snapshot = harness.snapshot()
    const window = createHarnessWindow({ url: snapshot.url as string, windowState, safeMode: mode === 'safe' })
    harnessWindows.add(window)
    window.on('closed', () => { harnessWindows.delete(window) })
    return window
  }

  const anyDesktopWindowCount = (): number => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length

  const raiseExisting = (): boolean => {
    const harnessWindow = [...harnessWindows].filter(window => !window.isDestroyed()).at(-1)
    const window = harnessWindow ?? getFailureWindow() ?? getPluginManagerWindow() ?? getAboutWindow()
    if (window === undefined || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return true
  }

  // Serialized boots with generation supersession (see window-activation.ts):
  // every request gets a generation; a superseded attempt must not touch any
  // window, so a stale boot finishing late can never open a window and
  // consecutive activate/Restart/Safe bursts can never duplicate windows.
  const bootQueue = createBootQueue()

  const bootAndShow = async (mode: 'normal' | 'safe'): Promise<{ ok: boolean; message: string }> => bootQueue.submit(async isCurrent => {
    closeHarnessWindows()
    if (runtimeError !== undefined) {
      const message = runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
      lastContext = { ...lastContext, mode, phase: 'failed', message, stderrTail: '' }
      if (isCurrent()) createFailureWindow(failureDeps())
      return { ok: false, message: 'runtime unavailable' }
    }
    lastContext = { mode, phase: 'starting', message: '', stderrTail: '', profileHome: harness.homeFor(mode) }
    let snapshot: Awaited<ReturnType<HarnessManager['start']>>
    try {
      snapshot = await harness.start(mode)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastContext = { ...lastContext, profileHome: harness.homeFor(mode), phase: 'failed', message, stderrTail: message }
      if (isCurrent()) createFailureWindow(failureDeps())
      return { ok: false, message }
    }
    if (!isCurrent()) return { ok: false, message: 'superseded by a newer boot request' }
    lastContext = { ...lastContext, profileHome: harness.homeFor(mode), phase: snapshot.phase, message: snapshot.message, stderrTail: snapshot.message }
    if (snapshot.phase === 'ready' && snapshot.url !== undefined) {
      getFailureWindow()?.destroy()
      openHarness(mode)
      if (testOpenPluginManager && process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined) {
        createPluginManagerWindow(plugins)
      }
    } else {
      createFailureWindow(failureDeps())
    }
    return { ok: snapshot.phase === 'ready', message: snapshot.message }
  })

  const selectExternalRuntime = async (): Promise<{ ok: boolean; message: string }> => {
    if (runtimeVariant !== 'thin') return { ok: false, message: 'runtime selection is available for Thin builds only' }
    const picked = await dialog.showOpenDialog({
      title: 'Select DSH Runtime…',
      properties: ['openDirectory'],
    })
    if (picked.canceled || picked.filePaths[0] === undefined) return { ok: false, message: 'cancelled' }
    try {
      const candidate = verifyRuntimeRoot(picked.filePaths[0], 'external', 'thin')
      writeRuntimeSourceConfig(userData, candidate.root)
      const nextServices = createServices(candidate)
      await harness.stop()
      services = nextServices
      ;({ pm, plugins, pnpmEntry, nodePath, supervisorPath, environment, runAsNode } = services)
      runtime = candidate
      runtimeError = undefined
      runtimeState = runtimeStatus(runtimeVariant, runtime)
      diagnostics = new DiagnosticsService(pm, userData, () => runtimeState)
      upgrades = new UpgradeManager({ userData, appPath: app.getAppPath(), profileManager: pm })
      upgrades.validateCompatibility()
      registerTestPlugin()
      const boot = await bootAndShow('normal')
      return { ok: boot.ok, message: boot.message }
    } catch (error) {
      runtimeError = error
      runtimeState = runtimeStatus(runtimeVariant, undefined, error)
      lastContext = { ...lastContext, phase: 'failed', message: error instanceof Error ? error.message : String(error), stderrTail: '' }
      return { ok: false, message: 'runtime rejected; see diagnostics' }
    }
  }

  const failureDeps = (): FailureWindowDeps => ({
    harness,
    plugins,
    profileManager: pm,
    diagnostics,
    userData,
    lastContext: () => lastContext,
    onRestart: () => bootAndShow(harness.mode),
    onSafeMode: () => bootAndShow('safe'),
    onSelectRuntime: selectExternalRuntime,
  })

  app.on('second-instance', () => {
    handleActivate({ allowCreate: false })
  })

  // Activation decision (see window-activation.ts): never create a window
  // while any exists, never duplicate during an in-flight boot.
  const handleActivate = ({ allowCreate }: { allowCreate: boolean }): void => {
    const snapshot = harness.snapshot()
    const decision = resolveActivation({
      pendingBootRequests: bootQueue.pending(),
      harnessWindowCount: harnessWindows.size,
      desktopWindowCount: anyDesktopWindowCount(),
      harnessReady: snapshot.phase === 'ready' && snapshot.url !== undefined,
      harnessRunning: harness.running,
    })
    if (decision === 'raise') {
      raiseExisting()
      return
    }
    if (!allowCreate) return
    if (decision === 'create') openHarness(harness.mode)
    else if (decision === 'boot') void bootAndShow(harness.mode)
  }

  const newHarnessWindow = (): void => {
    if (harness.snapshot().url !== undefined) openHarness(harness.mode)
    else createAboutWindow()
  }

  app.whenReady().then(() => {
    registerIpc()
    installApplicationMenu({
      harness,
      plugins,
      userData,
      openAbout: () => createAboutWindow(),
      newHarnessWindow,
      onRestart: () => { void bootAndShow(harness.mode) },
      onSafeMode: () => { void bootAndShow('safe') },
    })
    if (runtimeError !== undefined) createFailureWindow(failureDeps())
    else void bootAndShow(safeModeArg ? 'safe' : 'normal')
    app.on('activate', () => {
      handleActivate({ allowCreate: true })
    })
    if (process.env.DSH_DESKTOP_TEST_ACTIVATE_DRIVER === '1' && process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && process.env.DSH_DESKTOP_TEST_USER_DATA !== '') {
      void runActivateDriver()
    }
  })

  // Hidden integration driver (TASK-074): requires BOTH
  // DSH_DESKTOP_TEST_USER_DATA and DSH_DESKTOP_TEST_ACTIVATE_DRIVER, so it is
  // unreachable in production. It exercises the real activation path by
  // emitting genuine `app.emit('activate')` events and records window counts
  // after each scenario for the vitest assertion to read.
  const runActivateDriver = async (): Promise<void> => {
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const write = (results: Record<string, unknown>): void => {
      try {
        mkdirSync(join(userData, 'logs'), { recursive: true })
        writeFileSync(join(userData, 'logs', 'activate-result.json'), JSON.stringify({ ok: true, ...results }, null, 2) + '\n')
      } catch { /* best effort */ }
    }
    try {
      const deadline = Date.now() + 90_000
      while ((harnessWindows.size === 0 || harness.snapshot().phase !== 'ready') && Date.now() < deadline) await sleep(150)
      if (harnessWindows.size === 0) throw new Error('harness window never became ready')
      // 1) Five consecutive activations must keep exactly one window.
      for (let index = 0; index < 5; index++) {
        app.emit('activate')
        await sleep(150)
      }
      await sleep(400)
      const burstCount = harnessWindows.size
      const burstWindow = [...harnessWindows].at(-1)
      const burstUrl = burstWindow?.webContents.getURL() ?? ''
      const harnessPort = new URL(burstUrl).port
      // 2) Minimized window must be restored, not duplicated.
      ;[...harnessWindows].at(-1)?.minimize()
      app.emit('activate')
      await sleep(400)
      const restored = [...harnessWindows].at(-1)
      const restoreCount = harnessWindows.size
      const restoredMinimized = restored?.isMinimized() ?? true
      // 3) Activations during an in-flight restart must not duplicate.
      void bootAndShow(harness.mode)
      for (let index = 0; index < 25; index++) {
        app.emit('activate')
        await sleep(100)
      }
      const bootDeadline = Date.now() + 60_000
      while (harnessWindows.size === 0 && Date.now() < bootDeadline) await sleep(150)
      await sleep(500)
      const duringBootCount = harnessWindows.size
      // 4) After every window closed, activation creates exactly one.
      closeHarnessWindows()
      await sleep(400)
      app.emit('activate')
      await sleep(600)
      const afterCloseCount = harnessWindows.size
      const afterCloseReady = harness.snapshot().phase === 'ready'
      // 5) Explicit New Window stays available: 1 (from step 4) + 3 = 4.
      const explicitBefore = harnessWindows.size
      for (let index = 0; index < 3; index++) {
        newHarnessWindow()
        await sleep(200)
      }
      await sleep(300)
      const explicitAfter = harnessWindows.size
      write({
        burstCount,
        burstUrl,
        harnessPort,
        electronPid: process.pid,
        restoreCount,
        restoredMinimized,
        duringBootCount,
        afterCloseCount,
        afterCloseReady,
        explicitBefore,
        explicitAfter,
        snapshotUrl: typeof harness.snapshot().url === 'string',
      })
    } catch (error) {
      write({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      // Quit through the one and only before-quit path (harness.stop with
      // grace + forced-kill) so the packaged wrapper and every runtime
      // resource are cleaned up. Never app.exit() from the driver.
      await sleep(300)
      app.quit()
    }
  }

  // True quit: never keep a resident harness. Shut the runtime down with a
  // grace window and force-kill past it.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const force = setTimeout(() => app.exit(0), 9_000)
    void harness.stop().finally(() => {
      clearTimeout(force)
      app.exit(0)
    })
  })
  app.on('window-all-closed', () => {
    if (process.env.DSH_DESKTOP_TEST_KEEP_ALIVE_ON_ALL_CLOSED === '1' && process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && process.env.DSH_DESKTOP_TEST_USER_DATA !== '') return
    app.quit()
  })
}

bootstrap()
