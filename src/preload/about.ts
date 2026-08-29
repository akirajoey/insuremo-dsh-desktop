import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/contracts.ts'

const api: DesktopApi = {
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
  },
}

contextBridge.exposeInMainWorld('insuremoDesktop', api)
