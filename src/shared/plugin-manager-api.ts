import type { PluginEntry, PluginOperationResult } from '../main/plugins/contracts.ts'

export type { PluginEntry, PluginOperationResult }

export const PLUGIN_MANAGER_CAPABILITY = 'plugin-manager:all'

export interface PluginManagerApi {
  list(): Promise<PluginEntry[]>
  addSpec(spec: string): Promise<PluginOperationResult>
  remove(name: string): Promise<PluginOperationResult>
  rollback(): Promise<PluginOperationResult>
  pickTgz(): Promise<{ capabilityId: string; name: string } | undefined>
  pickDirectory(): Promise<{ capabilityId: string; name: string } | undefined>
  installCapability(capabilityId: string): Promise<PluginOperationResult>
}

declare global {
  interface Window {
    insuremoPlugins: PluginManagerApi
  }
}

export {}
