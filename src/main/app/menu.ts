import { app, Menu, shell } from 'electron'
import { join } from 'node:path'
import type { HarnessManager } from './harness-manager.ts'
import type { PluginService } from '../plugins/plugin-service.ts'
import { appRoot } from './app-root.ts'

export interface MenuDeps {
  harness: HarnessManager
  plugins: PluginService
  userData: string
  openAbout: () => void
  newHarnessWindow: () => void
  onRestart: () => void
  onSafeMode: () => void
}

/**
 * Native application menu per E05: New Window, Restart Harness, Manage
 * Plugins, Safe Mode, Logs, About — plus the standard macOS app menu and
 * true-quit role.
 */
export function installApplicationMenu(deps: MenuDeps): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'About InsureMO DSH Desktop', click: () => deps.openAbout() },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Harness',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => deps.newHarnessWindow() },
        { label: 'Restart Harness', accelerator: 'CmdOrCtrl+R', click: () => deps.onRestart() },
        { type: 'separator' },
        { label: 'Safe Mode', click: () => deps.onSafeMode() },
        { type: 'separator' },
        { label: 'Logs', click: () => { void shell.openPath(join(deps.userData, 'logs')) } },
        { label: 'About', click: () => deps.openAbout() },
      ],
    },
    {
      label: 'Plugins',
      submenu: [
        { label: 'Manage Plugins…', accelerator: 'CmdOrCtrl+Shift+P', click: () => { createPluginManagerFromDeps(deps) } },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createPluginManagerFromDeps(deps: MenuDeps): void {
  // Lazy import avoids a static cycle: the plugin-manager window module
  // already imports policy/security modules only.
  void import('../windows/plugin-manager-window.ts').then(({ createPluginManagerWindow }) => {
    createPluginManagerWindow(deps.plugins)
  }).catch(() => {
    // Window creation must never crash the menu handler.
  })
}

export function dockIconPath(): string {
  return join(appRoot(), 'build/icon.png')
}
