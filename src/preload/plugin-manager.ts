import { contextBridge, ipcRenderer } from 'electron'
import type { PluginManagerApi } from '../shared/plugin-manager-api.ts'

const api: PluginManagerApi = {
  list: () => ipcRenderer.invoke('plugin:list'),
  addSpec: (spec) => ipcRenderer.invoke('plugin:add-spec', spec),
  remove: (name) => ipcRenderer.invoke('plugin:remove', name),
  rollback: () => ipcRenderer.invoke('plugin:rollback'),
  pickTgz: () => ipcRenderer.invoke('plugin:pick-tgz'),
  pickDirectory: () => ipcRenderer.invoke('plugin:pick-directory'),
  installCapability: (capabilityId) => ipcRenderer.invoke('plugin:install-capability', capabilityId),
}

contextBridge.exposeInMainWorld('insuremoPlugins', api)
