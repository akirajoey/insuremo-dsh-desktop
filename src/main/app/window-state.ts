import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { screen } from 'electron'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Clamp restored bounds so the window is at least partially visible on a
 * connected display (handles monitor removal / resolution changes).
 * Pure so it can be unit-tested without Electron.
 */
export function clampToBounds(bounds: WindowBounds, workAreas: WorkArea[]): WindowBounds {
  const width = Math.max(640, Math.min(bounds.width, 16384))
  const height = Math.max(420, Math.min(bounds.height, 16384))
  const visible = workAreas.find(area => {
    return bounds.x !== undefined && bounds.y !== undefined
      && bounds.x >= area.x - width + 120 && bounds.x < area.x + area.width - 120
      && bounds.y >= area.y - 40 && bounds.y < area.y + area.height - 80
  })
  if (bounds.x === undefined || bounds.y === undefined || visible === undefined) {
    const area = workAreas[0]
    return {
      width,
      height,
      x: area === undefined ? undefined : area.x + Math.max(0, Math.floor((area.width - width) / 2)),
      y: area === undefined ? undefined : area.y + Math.max(0, Math.floor((area.height - height) / 3)),
      maximized: bounds.maximized,
    }
  }
  return { x: bounds.x, y: bounds.y, width, height, maximized: bounds.maximized }
}

interface WindowStateFile {
  version: 1
  windows: Record<string, WindowBounds>
}

/**
 * Persist and restore main-window bounds across launches. Restored bounds
 * are clamped so the window is at least partially visible on a connected
 * display (handles monitor removal / resolution changes).
 */
export class WindowStateStore {
  private readonly filePath: string
  private readonly workAreas: () => WorkArea[]

  constructor(userData: string, workAreas?: () => WorkArea[]) {
    this.filePath = join(userData, 'desktop-state', 'window-state.json')
    this.workAreas = workAreas ?? (() => screen.getAllDisplays().map(display => display.workArea))
  }

  restore(name: string, fallback: WindowBounds): WindowBounds {
    try {
      if (!existsSync(this.filePath)) return fallback
      const file = JSON.parse(readFileSync(this.filePath, 'utf8')) as WindowStateFile
      const saved = file.windows[name]
      if (saved === undefined) return fallback
      return clampToBounds(saved, this.workAreas())
    } catch {
      return fallback
    }
  }

  save(name: string, bounds: WindowBounds): void {
    try {
      const file: WindowStateFile = existsSync(this.filePath)
        ? JSON.parse(readFileSync(this.filePath, 'utf8')) as WindowStateFile
        : { version: 1, windows: {} }
      file.windows[name] = bounds
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(file, null, 2) + '\n')
    } catch {
      // Persistence is best-effort; never block window close on it.
    }
  }
}
