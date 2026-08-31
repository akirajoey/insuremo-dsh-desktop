import { describe, expect, it } from 'vitest'
import { createBootQueue, resolveActivation, type ActivationState } from '../src/main/app/window-activation'

const state = (overrides: Partial<ActivationState> = {}): ActivationState => ({
  pendingBootRequests: 0,
  harnessWindowCount: 0,
  desktopWindowCount: 0,
  harnessReady: true,
  harnessRunning: true,
  ...overrides,
})

describe('activation decision', () => {
  it('raises any existing window and never creates while one exists', () => {
    expect(resolveActivation(state({ desktopWindowCount: 1 }))).toBe('raise')
    expect(resolveActivation(state({ desktopWindowCount: 3, harnessWindowCount: 2 }))).toBe('raise')
    // Even a non-harness window (failure/about/plugin) blocks creation.
    expect(resolveActivation(state({ desktopWindowCount: 1, harnessReady: false }))).toBe('raise')
  })

  it('waits while a boot request is queued or in flight, before any other action', () => {
    expect(resolveActivation(state({ pendingBootRequests: 1 }))).toBe('wait-boot')
    expect(resolveActivation(state({ pendingBootRequests: 2, desktopWindowCount: 1 }))).toBe('wait-boot')
  })

  it('creates exactly one window only with zero windows and a ready harness', () => {
    expect(resolveActivation(state())).toBe('create')
  })

  it('boots when nothing runs and waits while running but not ready', () => {
    expect(resolveActivation(state({ harnessReady: false, harnessRunning: false }))).toBe('boot')
    expect(resolveActivation(state({ harnessReady: false, harnessRunning: true }))).toBe('wait-boot')
  })
})

describe('boot queue', () => {
  it('serializes attempts and reports pending requests', async () => {
    const queue = createBootQueue()
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = queue.submit(async () => {
      events.push('first-start')
      await firstGate
      events.push('first-end')
      return 'first'
    })
    expect(queue.pending()).toBe(1)
    const second = queue.submit(async () => {
      events.push('second-start')
      return 'second'
    })
    expect(queue.pending()).toBe(2)
    await Promise.resolve()
    expect(events).toEqual(['first-start'])
    releaseFirst?.()
    expect(await first).toBe('first')
    expect(await second).toBe('second')
    expect(events).toEqual(['first-start', 'first-end', 'second-start'])
    expect(queue.pending()).toBe(0)
  })

  it('marks every attempt except the newest as superseded, including late failures', async () => {
    const queue = createBootQueue()
    const attempts: Array<{ current: boolean; fail: boolean }> = []
    let releaseMiddle: (() => void) | undefined
    const middleGate = new Promise<void>(resolve => { releaseMiddle = resolve })
    const supersededRun = (fail: boolean) => async (isCurrent: () => boolean): Promise<string> => {
      attempts.push({ current: isCurrent(), fail })
      if (fail) throw new Error('boom')
      return isCurrent() ? 'opened-window' : 'superseded'
    }
    const a = queue.submit(supersededRun(false))
    const b = queue.submit(async isCurrent => {
      attempts.push({ current: isCurrent(), fail: false })
      await middleGate
      return isCurrent() ? 'opened-window' : 'superseded'
    })
    const c = queue.submit(supersededRun(true))
    releaseMiddle?.()
    expect(await a).toBe('superseded')
    // The middle attempt was superseded by c's submission before its turn.
    expect(await b).toBe('superseded')
    await expect(c).rejects.toThrow('boom')
    // Only the newest attempt sees isCurrent() true at every checkpoint.
    expect(attempts.map(entry => entry.current)).toEqual([false, false, true])
    expect(queue.pending()).toBe(0)
  })
})
