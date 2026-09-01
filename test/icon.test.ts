import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ICON_DERIVATIVE_SHA256,
  ICON_PNG_SIZE,
  ICON_SOURCE,
  ICON_SOURCE_ARCHIVE,
  ICON_SOURCE_ARCHIVE_SHA256,
  ICON_SOURCE_SHA256,
  ICON_SOURCE_SIZE,
  ICO_LADDER,
  assembleIco,
  decodePngPixels,
  pngAlphaAt,
  pngInfo,
  pngSize,
  verifyDesignAssets,
} from '../scripts/gen-icon.mjs'

const root = resolve(import.meta.dirname, '..')

describe('application icon contract', () => {
  it('pins the elephant source/archive and verifies the optical footprint', { timeout: 15_000 }, () => {
    const archive = readFileSync(resolve(root, ICON_SOURCE_ARCHIVE))
    expect(createHash('sha256').update(archive).digest('hex')).toBe(ICON_SOURCE_ARCHIVE_SHA256)
    expect(pngInfo(archive)).toMatchObject({ width: ICON_SOURCE_SIZE, height: ICON_SOURCE_SIZE, bitDepth: 8, colorType: 2, compression: 0, filter: 0, interlace: 0 })
    const source = readFileSync(resolve(root, ICON_SOURCE))
    expect(createHash('sha256').update(source).digest('hex')).toBe(ICON_SOURCE_SHA256)
    expect(pngInfo(source)).toMatchObject({ width: ICON_SOURCE_SIZE, height: ICON_SOURCE_SIZE, bitDepth: 8, colorType: 6, compression: 0, filter: 0, interlace: 0 })
    expect(pngSize(source)).toEqual({ width: ICON_SOURCE_SIZE, height: ICON_SOURCE_SIZE })
    const sourcePixels = decodePngPixels(source)
    expect(sourcePixels.channels).toBe(4)
    const alphaAt = (x: number, y: number) => sourcePixels.pixels[(y * sourcePixels.width + x) * sourcePixels.channels + 3]
    let minX = sourcePixels.width
    let minY = sourcePixels.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < sourcePixels.height; y++) {
      for (let x = 0; x < sourcePixels.width; x++) {
        if (alphaAt(x, y) === 0) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    expect({ minX, minY, maxX, maxY }).toEqual({ minX: 93, minY: 93, maxX: 1159, maxY: 1159 })
    expect(maxX - minX + 1).toBeGreaterThanOrEqual(1066)
    expect(maxX - minX + 1).toBeLessThanOrEqual(1072)
    const sourceCorners = [[0, 0], [ICON_SOURCE_SIZE - 1, 0], [0, ICON_SOURCE_SIZE - 1], [ICON_SOURCE_SIZE - 1, ICON_SOURCE_SIZE - 1]]
    expect(sourceCorners.map(([x, y]) => alphaAt(x, y))).toEqual([0, 0, 0, 0])
    expect(alphaAt(627, 92)).toBe(0)
    expect(alphaAt(627, 93)).toBeGreaterThan(0)
    expect(alphaAt(627, 94)).toBeLessThan(255)
    expect(alphaAt(627, 96)).toBe(255)
    expect(alphaAt(627, 627)).toBe(255)
    const { ladder } = verifyDesignAssets()
    expect(Object.keys(ladder).map(Number).sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256, 512, 1024])
    expect(pngSize(ladder[ICON_PNG_SIZE])).toEqual({ width: ICON_PNG_SIZE, height: ICON_PNG_SIZE })
  })

  it('assembles a valid PNG-embedded Windows ICO structure', () => {
    const { ladder } = verifyDesignAssets()
    const ico = assembleIco(ICO_LADDER.map(size => ({ size, bytes: ladder[size] })))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1) // icon type
    expect(ico.readUInt16LE(4)).toBe(ICO_LADDER.length)
    let offset = 6 + 16 * ICO_LADDER.length
    ICO_LADDER.forEach((size, index) => {
      const base = 6 + 16 * index
      const widthByte = ico[base]
      expect(widthByte).toBe(size >= 256 ? 0 : size) // 0 encodes 256
      expect(ico[base + 1]).toBe(widthByte)
      expect(ico.readUInt16LE(base + 4)).toBe(1)
      expect(ico.readUInt16LE(base + 6)).toBe(32)
      const payloadSize = ico.readUInt32LE(base + 8)
      const payloadOffset = ico.readUInt32LE(base + 12)
      expect(payloadOffset).toBe(offset)
      const payload = ico.subarray(payloadOffset, payloadOffset + payloadSize)
      expect(payloadSize).toBe(ladder[size].length)
      expect(createHash('sha256').update(payload).digest('hex')).toBe(ICON_DERIVATIVE_SHA256[size])
      expect(pngSize(payload)).toEqual({ width: size, height: size })
      expect(pngInfo(payload)).toMatchObject({ bitDepth: 8, colorType: 6, interlace: 0 })
      expect([pngAlphaAt(payload, 0, 0), pngAlphaAt(payload, size - 1, 0), pngAlphaAt(payload, 0, size - 1), pngAlphaAt(payload, size - 1, size - 1)]).toEqual([0, 0, 0, 0])
      expect(pngAlphaAt(payload, Math.floor(size / 2), Math.floor(size / 2))).toBe(255)
      offset += payloadSize
    })
    expect(offset).toBe(ico.length)
    expect(ico.length).toBeGreaterThan(0)
  })

  it('builds icon assets only from the pinned design source', () => {
    const script = readFileSync(resolve(root, 'scripts/gen-icon.mjs'), 'utf8')
    expect(script).toContain('ICON_SOURCE_ARCHIVE_SHA256')
    expect(script).toContain('ICON_SOURCE_SHA256')
    // No image tooling can be invoked from the build script at all.
    expect(script).not.toContain("from 'node:child_process'")
    expect(script).toContain("join(root, 'design', 'icons'")
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { build: { icon?: string; win?: { icon?: string } } }
    expect(packageJson.build.icon).toBe('build/icon.png')
    expect(packageJson.build.win?.icon).toBe('build/icon.ico')
  })
})
