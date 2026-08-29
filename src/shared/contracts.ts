export type RuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

export type RuntimeSnapshot = {
  phase: RuntimePhase
  url?: string
  message: string
}

export type PluginOperation = 'add' | 'update' | 'remove'
export type ProfileRecoveryOperation = 'rollback' | 'rebuild'

export type DesktopApi = {
  app: {
    version: () => Promise<string>
  }
}

declare global {
  interface Window {
    insuremoDesktop: DesktopApi
  }
}

export {}
