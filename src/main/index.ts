import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
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
import { resolveNodePath, resolvePnpmEntry } from './app/runtime-paths.ts'
import { verifyPackagedRuntime, type RuntimeResourceLayout } from './app/runtime-resources.ts'
import { UpgradeManager } from './upgrade/upgrade-manager.ts'

const hasSingleInstance = app.requestSingleInstanceLock()
const safeModeArg = process.argv.includes('--safe-mode') || process.env.DSH_DESKTOP_SAFE_MODE === '1'

function configureUserData(): void {
  const testOverride = process.env.DSH_DESKTOP_TEST_USER_DATA
  if (testOverride !== undefined && testOverride !== '') {
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
}

function createServices(runtime?: RuntimeResourceLayout): DesktopServices {
  const userData = app.getPath('userData')
  const dshHome = join(userData, 'harness')
  const pnpmEntry = runtime?.pnpmEntry ?? resolvePnpmEntry()
  const nodePath = runtime?.nodePath ?? resolveNodePath()
  const pm = new ProfileManager({
    userData,
    dshHome,
    runtimeAnchor: runtime?.harnessRoot,
    pnpmEntry,
    nodePath,
    workbenchTgzPath: runtime?.workbenchTgz ?? '',
    workbenchSha256: runtime?.workbenchSha256 ?? '',
  })
  const plugins = new PluginService({
    profileManager: pm,
    capabilityDir: join(userData, 'desktop-state', 'plugin-capabilities'),
    pnpmEntry,
    nodePath,
    workbenchName: '@icomposer/workbench',
  })
  return { pm, plugins, pnpmEntry, nodePath, supervisorPath: runtime?.supervisorPath }
}

let quitting = false

function bootstrap(): void {
  configureUserData()
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
  const runtime = app.isPackaged ? verifyPackagedRuntime() : undefined
  const { pm, plugins, pnpmEntry, nodePath, supervisorPath } = createServices(runtime)
  const upgrades = new UpgradeManager({ userData, appPath: app.getAppPath(), profileManager: pm })
  upgrades.validateCompatibility()
  const testPluginTgz = process.env.DSH_DESKTOP_TEST_PLUGIN_TGZ
  if (process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && testPluginTgz !== undefined && testPluginTgz !== '') {
    plugins.registerCapability('packaged-smoke', testPluginTgz)
  }
  const testAutoQuitMs = Number(process.env.DSH_DESKTOP_TEST_AUTO_QUIT_AFTER_MS)
  if (process.env.DSH_DESKTOP_TEST_USER_DATA !== undefined && Number.isFinite(testAutoQuitMs) && testAutoQuitMs > 0) {
    setTimeout(() => app.quit(), testAutoQuitMs)
  }
  const harness = new HarnessManager({
    userData,
    profileManager: pm,
    runtimePin: readRuntimePin(join(app.getAppPath())),
    pnpmEntry,
    nodePath,
    forkMode: app.isPackaged ? 'fork' : 'utility',
    execPath: app.isPackaged ? nodePath : undefined,
    supervisorPath,
  })
  const windowState = new WindowStateStore(userData)
  const diagnostics = new DiagnosticsService(pm, userData)
  let lastContext: DiagnosticsContext = { mode: safeModeArg ? 'safe' : 'normal', phase: 'starting', message: '', stderrTail: '', profileHome: safeModeArg ? join(userData, 'safe-runtime/harness') : join(userData, 'harness') }

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

  const raiseExisting = (): void => {
    const harnessWindow = [...harnessWindows].at(-1)
    const window = harnessWindow ?? getFailureWindow() ?? getPluginManagerWindow() ?? getAboutWindow() ?? createAboutWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
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
  })

  const bootAndShow = async (mode: 'normal' | 'safe'): Promise<{ ok: boolean; message: string }> => {
    closeHarnessWindows()
    lastContext = { mode, phase: 'starting', message: '', stderrTail: '', profileHome: harness.homeFor(mode) }
    let snapshot: Awaited<ReturnType<HarnessManager['start']>>
    try {
      snapshot = await harness.start(mode)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastContext = { ...lastContext, profileHome: harness.homeFor(mode), phase: 'failed', message, stderrTail: message }
      createFailureWindow(failureDeps())
      return { ok: false, message }
    }
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
  }

  app.on('second-instance', () => {
    raiseExisting()
  })

  app.whenReady().then(() => {
    registerIpc()
    installApplicationMenu({
      harness,
      plugins,
      userData,
      openAbout: () => createAboutWindow(),
      newHarnessWindow: () => {
        if (harness.snapshot().url !== undefined) openHarness(harness.mode)
        else createAboutWindow()
      },
      onRestart: () => { void bootAndShow(harness.mode) },
      onSafeMode: () => { void bootAndShow('safe') },
    })
    void bootAndShow(safeModeArg ? 'safe' : 'normal')
    app.on('activate', () => {
      if (harness.snapshot().url !== undefined) openHarness(harness.mode)
      else if (!harness.running) void bootAndShow(harness.mode)
    })
  })

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
    app.quit()
  })
}

if (!hasSingleInstance) {
  app.quit()
} else {
  bootstrap()
}
