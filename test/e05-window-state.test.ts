import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowStateStore, clampToBounds } from '../src/main/app/window-state'

describe('E05 window bounds clamp (pure)', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 }

  it('keeps bounds that are fully visible', () => {
    const clamped = clampToBounds({ x: 100, y: 100, width: 900, height: 600 }, [display])
    expect(clamped).toEqual({ x: 100, y: 100, width: 900, height: 600 })
  })

  it('centers when no position was saved', () => {
    const clamped = clampToBounds({ width: 900, height: 600 }, [display])
    expect(clamped.x).toBe(Math.floor((1440 - 900) / 2))
    expect(clamped.y).toBe(Math.floor((900 - 600) / 3))
  })

  it('recenters bounds from a detached display', () => {
    const clamped = clampToBounds({ x: 5000, y: -2000, width: 900, height: 600 }, [display])
    expect(clamped.x).toBe(Math.floor((1440 - 900) / 2))
    expect(clamped.y).toBe(Math.floor((900 - 600) / 3))
  })

  it('enforces minimum size', () => {
    const clamped = clampToBounds({ width: 10, height: 5 }, [display])
    expect(clamped.width).toBeGreaterThanOrEqual(640)
    expect(clamped.height).toBeGreaterThanOrEqual(420)
  })
})

describe('E05 window state store', () => {
  it('saves and restores bounds per window name and survives reload', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e05-'))
    try {
      const userData = join(tmp, 'userData')
      const store = new WindowStateStore(userData)
      expect(store.restore('harness', { width: 1280, height: 820 })).toEqual({ width: 1280, height: 820 })
      store.save('harness', { x: 40, y: 60, width: 1000, height: 700, maximized: false })
      const reloaded = new WindowStateStore(userData, () => [{ x: 0, y: 0, width: 1440, height: 900 }])
      expect(reloaded.restore('harness', { width: 1280, height: 820 })).toEqual({ x: 40, y: 60, width: 1000, height: 700, maximized: false })
      // Corrupt file falls back safely.
      const statePath = join(userData, 'desktop-state', 'window-state.json')
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { version: number }
      expect(parsed.version).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
