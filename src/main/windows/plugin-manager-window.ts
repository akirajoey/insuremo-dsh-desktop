import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PluginService } from '../plugins/plugin-service.ts'
import { PLUGIN_MANAGER_CAPABILITY, type PluginManagerApi } from '../../shared/plugin-manager-api.ts'
import { isExactUrl, authorizeIpc } from '../security/policy.ts'
import { appRoot } from '../app/app-root.ts'

let pluginWindow: BrowserWindow | undefined
let ipcHandlersRegistered = false
// Handlers are registered once per process; each registration re-points to
// the active service so reopening the window never double-registers.
let activeService: PluginService | undefined

export function getPluginManagerWindow(): BrowserWindow | undefined {
  return pluginWindow
}

function expectedUrl(): string {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined) {
    return new URL('plugin-manager/index.html', devServerUrl.endsWith('/') ? devServerUrl : `${devServerUrl}/`).href
  }
  return pathToFileURL(join(appRoot(), 'out/renderer/plugin-manager/index.html')).href
}

function authorize(event: Electron.IpcMainInvokeEvent): boolean {
  const window = getPluginManagerWindow()
  const frame = event.senderFrame
  return window !== undefined && frame !== null && authorizeIpc({
    sender: event.sender,
    expectedSender: window.webContents,
    senderFrame: frame,
    mainFrame: event.sender.mainFrame,
    frameUrl: frame.url,
    expectedUrl: expectedUrl(),
    capability: PLUGIN_MANAGER_CAPABILITY,
    expectedCapability: PLUGIN_MANAGER_CAPABILITY,
    destroyed: window.isDestroyed(),
  })
}

function registerPluginIpc(service: PluginService): void {
  activeService = service
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true
  const handlers: Record<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> = {
    'plugin:list': (event) => {
      if (!authorize(event)) throw new Error('forbidden')
      return activeService?.listPlugins()
    },
    'plugin:add-spec': async (event, spec) => {
      if (!authorize(event)) throw new Error('forbidden')
      if (typeof spec !== 'string') throw new Error('invalid spec')
      if (activeService === undefined) throw new Error('plugin service unavailable')
      return activeService.runOperation('add', spec)
    },
    'plugin:remove': async (event, name) => {
      if (!authorize(event)) throw new Error('forbidden')
      if (typeof name !== 'string') throw new Error('invalid name')
      if (activeService === undefined) throw new Error('plugin service unavailable')
      return activeService.runOperation('remove', name)
    },
    'plugin:rollback': async (event) => {
      if (!authorize(event)) throw new Error('forbidden')
      if (activeService === undefined) throw new Error('plugin service unavailable')
      return activeService.rollback()
    },
    'plugin:pick-tgz': async (event) => {
      if (!authorize(event)) throw new Error('forbidden')
      const window = getPluginManagerWindow()
      if (window === undefined || activeService === undefined) throw new Error('no window')
      const result = await dialog.showOpenDialog(window, {
        title: 'Select a plugin tgz',
        properties: ['openFile'],
        filters: [{ name: 'Plugin archive', extensions: ['tgz', 'gz'] }],
      })
      if (result.canceled || result.filePaths.length === 0) return undefined
      const capabilityId = `tgz:${randomUUID()}`
      activeService?.registerCapability(capabilityId.slice(4), result.filePaths[0])
      return { capabilityId, name: basename(result.filePaths[0]) }
    },
    'plugin:pick-directory': async (event) => {
      if (!authorize(event)) throw new Error('forbidden')
      const window = getPluginManagerWindow()
      if (window === undefined) throw new Error('no window')
      const result = await dialog.showOpenDialog(window, {
        title: 'Select a local plugin directory',
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return undefined
      const capabilityId = `local:${randomUUID()}`
      activeService?.registerCapability(capabilityId.slice(6), result.filePaths[0])
      return { capabilityId, name: basename(result.filePaths[0]) }
    },
    'plugin:install-capability': async (event, capabilityId) => {
      if (!authorize(event)) throw new Error('forbidden')
      if (typeof capabilityId !== 'string') throw new Error('invalid capability')
      if (activeService === undefined) throw new Error('plugin service unavailable')
      return activeService.runOperation('add', capabilityId, capabilityId)
    },
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler)
  }
}

export function createPluginManagerWindow(service: PluginService): BrowserWindow {
  if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
    pluginWindow.show()
    pluginWindow.focus()
    return pluginWindow
  }
  const url = expectedUrl()
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 480,
    show: false,
    title: 'Plugin Manager',
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: join(appRoot(), 'out/preload/plugin-manager.cjs'),
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
    if (pluginWindow === window) pluginWindow = undefined
  })
  pluginWindow = window
  registerPluginIpc(service)
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined) void window.loadURL(url)
  else void window.loadFile(join(appRoot(), 'out/renderer/plugin-manager/index.html'))
  return window
}
