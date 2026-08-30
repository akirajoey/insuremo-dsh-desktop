import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isExactUrl, authorizeIpc } from '../security/policy.ts'
import { FAILURE_CAPABILITY } from '../../shared/failure-api.ts'
import { appRoot } from '../app/app-root.ts'
import type { HarnessManager } from '../app/harness-manager.ts'
import { DiagnosticsService, type DiagnosticsContext } from '../app/diagnostics.ts'
import type { PluginService } from '../plugins/plugin-service.ts'
import type { ProfileManager } from '../profile/profile-manager.ts'

let failureWindow: BrowserWindow | undefined
let ipcRegistered = false

export function getFailureWindow(): BrowserWindow | undefined {
  return failureWindow
}

function failurePageUrl(): string {
  return pathToFileURL(join(appRoot(), 'out/renderer/failure/index.html')).href
}

export interface FailureWindowDeps {
  harness: HarnessManager
  plugins: PluginService
  profileManager: ProfileManager
  diagnostics: DiagnosticsService
  userData: string
  lastContext: () => DiagnosticsContext
  onRestart: () => Promise<{ ok: boolean; message: string }>
  onSafeMode: () => Promise<{ ok: boolean; message: string }>
  onSelectRuntime: () => Promise<{ ok: boolean; message: string }>
}

function authorize(event: Electron.IpcMainInvokeEvent): boolean {
  const window = getFailureWindow()
  const frame = event.senderFrame
  return window !== undefined && !window.isDestroyed() && frame !== null && authorizeIpc({
    sender: event.sender,
    expectedSender: window.webContents,
    senderFrame: frame,
    mainFrame: event.sender.mainFrame,
    frameUrl: frame.url,
    expectedUrl: failurePageUrl(),
    capability: FAILURE_CAPABILITY,
    expectedCapability: FAILURE_CAPABILITY,
    destroyed: window.isDestroyed(),
  })
}

function registerFailureIpc(deps: FailureWindowDeps): void {
  if (ipcRegistered) return
  ipcRegistered = true
  const confirmed = async (window: BrowserWindow, message: string): Promise<boolean> => {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Continue'],
      defaultId: 0,
      cancelId: 0,
      message,
      detail: 'This changes the harness profile on disk. Your files are not touched.',
    })
    return result.response === 1
  }
  ipcMain.handle('failure:diagnostics', (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    return deps.diagnostics.collect(deps.lastContext())
  })
  ipcMain.handle('failure:restart', async (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    return deps.onRestart()
  })
  ipcMain.handle('failure:enter-safe-mode', async (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    return deps.onSafeMode()
  })
  ipcMain.handle('failure:rollback', async (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    const window = getFailureWindow()
    if (window === undefined) throw new Error('no window')
    if (!await confirmed(window, 'Roll the harness profile back to the previous verified generation?')) {
      return { ok: false, message: 'cancelled' }
    }
    const outcome = await rollbackPreviousGeneration(deps.profileManager)
    return { ok: outcome, message: outcome ? 'rolled back' : 'no previous generation available' }
  })
  ipcMain.handle('failure:rebuild', async (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    const window = getFailureWindow()
    if (window === undefined) throw new Error('no window')
    if (!await confirmed(window, 'Rebuild the harness profile from its manifest? This reinstalls every listed dependency.')) {
      return { ok: false, message: 'cancelled' }
    }
    return deps.plugins.rebuild()
  })
  ipcMain.handle('failure:remove-plugin', async (event, name) => {
    if (!authorize(event)) throw new Error('forbidden')
    if (typeof name !== 'string' || name === '') throw new Error('invalid plugin name')
    const window = getFailureWindow()
    if (window === undefined) throw new Error('no window')
    if (!await confirmed(window, `Remove plugin ${name} from the harness profile?`)) {
      return { ok: false, message: 'cancelled' }
    }
    return deps.plugins.runOperation('remove', name)
  })
  ipcMain.handle('failure:select-runtime', async (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    return deps.onSelectRuntime()
  })
  ipcMain.handle('failure:open-logs', (event) => {
    if (!authorize(event)) throw new Error('forbidden')
    void shell.openPath(join(deps.userData, 'logs'))
  })
}

async function rollbackPreviousGeneration(pm: ProfileManager): Promise<boolean> {
  const prev = join(pm.dshHome, 'profiles/web.prev')
  if (!existsSync(join(prev, 'package.json'))) return false
  pm.rollbackToPreviousGeneration('failure-window-rollback')
  return true
}

export function createFailureWindow(deps: FailureWindowDeps): BrowserWindow {
  registerFailureIpc(deps)
  if (failureWindow !== undefined && !failureWindow.isDestroyed()) {
    failureWindow.show()
    failureWindow.focus()
    return failureWindow
  }
  const url = failurePageUrl()
  const window = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'InsureMO DSH Desktop — Recovery',
    backgroundColor: '#f7f9fc',
    icon: join(appRoot(), 'build/icon.png'),
    webPreferences: {
      preload: join(appRoot(), 'out/preload/failure.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isExactUrl(targetUrl, url)) event.preventDefault()
  })
  window.once('ready-to-show', () => {
    if (process.env.DSH_DESKTOP_TEST_HEADLESS !== '1') window.show()
  })
  window.on('closed', () => {
    if (failureWindow === window) failureWindow = undefined
  })
  failureWindow = window
  void window.loadFile(join(appRoot(), 'out/renderer/failure/index.html'))
  return window
}
