export const FAILURE_CAPABILITY = 'failure:diagnostics'

export interface FailureProfileDiagnostics {
  dir: string
  exists: boolean
  dependencies: Record<string, string>
  bundles: string[]
  missingModules: string[]
  lockfileSha256: string | null
  lockfileParses: boolean | null
}

export interface FailureRuntimeDiagnostics {
  variant: 'full' | 'thin'
  source: 'embedded' | 'external' | 'unavailable'
  rootName: string | null
  error: string | null
}

export interface FailureDiagnostics {
  mode: 'normal' | 'safe'
  runtime: FailureRuntimeDiagnostics
  phase: string
  message: string
  stderrTail: string
  profile: FailureProfileDiagnostics
  provenanceTail: Array<{
    operationId: string
    operation: string
    resolvedName: string
    resolvedVersion: string
    outcome: string
    installedAt: number
  }>
  logTail: string
}

export interface FailureActionResult {
  ok: boolean
  message: string
}

export interface FailureApi {
  diagnostics(): Promise<FailureDiagnostics>
  restart(): Promise<FailureActionResult>
  enterSafeMode(): Promise<FailureActionResult>
  rollback(): Promise<FailureActionResult>
  rebuild(): Promise<FailureActionResult>
  removePlugin(name: string): Promise<FailureActionResult>
  selectRuntime(): Promise<FailureActionResult>
  openLogs(): Promise<void>
}

declare global {
  interface Window {
    insuremoFailure: FailureApi
  }
}
