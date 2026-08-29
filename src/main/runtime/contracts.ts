export type ControlRequest = {
  type: 'shutdown'
  requestId: string
}

export type ControlReply =
  | { type: 'accepted'; requestId: string }
  | { type: 'exited'; requestId: string; code: number | null; signal: string | null; elapsedMs: number }
  | { type: 'timeout'; requestId: string }
  | { type: 'forced'; requestId: string }

export type RuntimeHandshake = {
  launchId: string
  pid: number
  startTime: number
  exec: string
  cwd: string
  port: number
}

export type RuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

export type RuntimeSnapshot = {
  phase: RuntimePhase
  url?: string
  message: string
}

export type ChildExit = {
  code: number | null
  signal: string | null
  elapsedMs: number
}

export type ShutdownOutcome =
  | { kind: 'exited'; exit: ChildExit }
  | { kind: 'timeout' }
  | { kind: 'forced'; exit: ChildExit | undefined }

export type ControlState = 'idle' | 'accepted' | 'exited' | 'timeout' | 'forced'
