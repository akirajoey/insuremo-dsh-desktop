/**
 * Activation and boot-queue decision logic for the desktop shell, extracted
 * from the Electron main seam so it stays unit-testable without Electron.
 *
 * The activation rule (TASK-074): dock/focus `activate` events must never
 * create a second harness window. Raise an existing window when one exists,
 * create exactly one only when no window exists at all and the harness is
 * ready, trigger a single boot when nothing is running, and stay quiet while
 * a boot request is queued or in flight (the boot opens its own window).
 */

export type ActivationDecision = 'raise' | 'create' | 'boot' | 'wait-boot'

export interface ActivationState {
  /** Boot requests queued or running (see createBootQueue). */
  pendingBootRequests: number
  /** Number of live harness windows. */
  harnessWindowCount: number
  /** Number of live desktop windows of any kind (harness, failure, plugin, about). */
  desktopWindowCount: number
  /** The harness snapshot is ready with a loadable URL. */
  harnessReady: boolean
  /** The harness runtime is currently running. */
  harnessRunning: boolean
}

export function resolveActivation(state: ActivationState): ActivationDecision {
  if (state.pendingBootRequests > 0) return 'wait-boot'
  if (state.desktopWindowCount > 0) return 'raise'
  if (state.harnessReady) return 'create'
  if (!state.harnessRunning) return 'boot'
  return 'wait-boot'
}

export interface BootQueue {
  /**
   * Submit a boot attempt. `run` receives an `isCurrent` closure; when it
   * returns false the attempt was superseded by a newer submission and must
   * not touch any window. Attempts are serialized; only the newest
   * submission observes `isCurrent() === true` at every checkpoint.
   */
  submit<R>(run: (isCurrent: () => boolean) => Promise<R>): Promise<R>
  /** Boot requests queued or running right now. */
  pending(): number
}

export function createBootQueue(): BootQueue {
  let generation = 0
  let pendingRequests = 0
  let chain: Promise<unknown> = Promise.resolve()
  return {
    submit<R>(run: (isCurrent: () => boolean) => Promise<R>): Promise<R> {
      const mine = ++generation
      pendingRequests++
      const attempt = (): Promise<R> => run(() => mine === generation)
      const result = chain.then(attempt, attempt)
      chain = result.catch(() => undefined)
      void result.finally(() => { pendingRequests-- }).catch(() => undefined)
      return result
    },
    pending(): number {
      return pendingRequests
    },
  }
}
