import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { WindowStateStore } from '../app/window-state.ts'
import { appRoot } from '../app/app-root.ts'

export const HARNESS_WINDOW = 'harness'

export interface HarnessWindowOptions {
  url: string
  windowState: WindowStateStore
  safeMode: boolean
}

export function harnessWindowIconPath(): string {
  return join(appRoot(), 'build/icon.png')
}

export function harnessThemeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f7f9fc'
}

export function createHarnessWindow(options: HarnessWindowOptions): BrowserWindow {
  const bounds = options.windowState.restore(HARNESS_WINDOW, { width: 1280, height: 820 })
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    title: options.safeMode ? 'InsureMO DSH Desktop (Safe Mode)' : 'InsureMO DSH Desktop',
    backgroundColor: harnessThemeBackground(),
    icon: harnessWindowIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  if (bounds.maximized) window.maximize()
  const allowedOrigin = new URL(options.url).origin
  const windowTitle = options.safeMode ? 'InsureMO DSH Desktop (Safe Mode)' : 'InsureMO DSH Desktop'
  window.webContents.on('page-title-updated', event => {
    event.preventDefault()
    window.setTitle(windowTitle)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(`${allowedOrigin}/`)) event.preventDefault()
  })
  window.once('ready-to-show', () => {
    if (process.env.DSH_DESKTOP_TEST_HEADLESS !== '1') window.show()
  })
  window.on('close', () => {
    options.windowState.save(HARNESS_WINDOW, { ...window.getBounds(), maximized: window.isMaximized() })
  })
  void window.loadURL(options.url)
  return window
}
