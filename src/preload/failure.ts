import { contextBridge, ipcRenderer } from 'electron'
import type { FailureApi } from '../shared/failure-api.ts'

const api: FailureApi = {
  diagnostics: () => ipcRenderer.invoke('failure:diagnostics'),
  restart: () => ipcRenderer.invoke('failure:restart'),
  enterSafeMode: () => ipcRenderer.invoke('failure:enter-safe-mode'),
  rollback: () => ipcRenderer.invoke('failure:rollback'),
  rebuild: () => ipcRenderer.invoke('failure:rebuild'),
  removePlugin: (name) => ipcRenderer.invoke('failure:remove-plugin', name),
  openLogs: () => ipcRenderer.invoke('failure:open-logs'),
}

contextBridge.exposeInMainWorld('insuremoFailure', api)
