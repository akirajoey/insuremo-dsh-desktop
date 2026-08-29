import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ABOUT_CONTENT_SECURITY_POLICY,
  decideNavigation,
} from '../security/policy.ts'

let aboutWindow: BrowserWindow | undefined

export function getAboutUrl(): string {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined) {
    return new URL('/', devServerUrl.endsWith('/') ? devServerUrl : `${devServerUrl}/`).href
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function getAboutWindow(): BrowserWindow | undefined {
  return aboutWindow
}

function configureNavigation(window: BrowserWindow, expectedUrl: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, expectedUrl) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, expectedUrl)
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'external') void shell.openExternal(url)
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

export function createAboutWindow(): BrowserWindow {
  if (aboutWindow !== undefined && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return aboutWindow
  }

  const expectedUrl = getAboutUrl()
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'InsureMO DSH Desktop',
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: join(__dirname, '../preload/about.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })

  configureNavigation(window, expectedUrl)
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`preload failed: ${preloadPath}`, error)
  })
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    headers['Content-Security-Policy'] = [ABOUT_CONTENT_SECURITY_POLICY]
    callback({ responseHeaders: headers })
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (aboutWindow === window) aboutWindow = undefined
  })
  aboutWindow = window

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined) {
    void window.loadURL(expectedUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}
