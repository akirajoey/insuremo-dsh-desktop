export type PluginOperation = 'add' | 'update' | 'remove' | 'rollback' | 'rebuild'

export type PluginSourceKind = 'npm' | 'alias' | 'git' | 'tgz' | 'local'

export type PluginSpec =
  | { kind: 'npm'; package: string; version?: string }
  | { kind: 'alias'; alias: string; target: string; version?: string }
  | { kind: 'git'; url: string }
  | { kind: 'tgz'; capabilityId: string }
  | { kind: 'local'; capabilityId: string }

export interface PluginEntry {
  name: string
  version: string
  description?: string
  isBundle: boolean
  isWorkbench: boolean
  source?: PluginSourceKind
}

export interface PluginProvenance {
  operationId: string
  operation: PluginOperation
  requestedSpecDigest: string
  resolvedName: string
  resolvedVersion: string
  lockfileIntegrity: string
  tgzSha256?: string
  installedAt: number
  outcome: 'committed' | 'rolled_back'
}

export interface PluginOperationResult {
  operationId: string
  operation: PluginOperation
  ok: boolean
  message: string
  provenance?: PluginProvenance
}
