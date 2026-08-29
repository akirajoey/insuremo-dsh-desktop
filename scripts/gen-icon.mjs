/**
 * Generate the desktop shell application icon (build/icon.png, 512x512).
 * Deterministic, dependency-free PNG writer: a rounded teal square with a
 * white three-dot "dsh" motif. Placeholder pending formal brand design
 * (final icon identity is finalized with E07 packaging).
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512

function pixel(x, y) {
  const margin = 48
  const radius = 96
  const inside = x >= margin && x < SIZE - margin && y >= margin && y < SIZE - margin
  if (!inside) return [0, 0, 0, 0]
  // rounded corners
  const cx = x < margin + radius ? margin + radius : x >= SIZE - margin - radius ? SIZE - margin - radius : x
  const cy = y < margin + radius ? margin + radius : y >= SIZE - margin - radius ? SIZE - margin - radius : y
  const dx = x - cx
  const dy = y - cy
  if (dx * dx + dy * dy > radius * radius) return [0, 0, 0, 0]
  // three diagonal dots motif
  const dots = [[170, 170], [256, 256], [342, 342]]
  for (const [px, py] of dots) {
    const ddx = x - px
    const ddy = y - py
    if (ddx * ddx + ddy * ddy <= 46 * 46) return [255, 255, 255, 255]
  }
  // subtle vertical gradient teal
  const t = (y - margin) / (SIZE - 2 * margin)
  return [Math.round(19 + 8 * t), Math.round(124 + 16 * t), Math.round(139 + 18 * t), 255]
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcTable = crc32Table()
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, body, crcBuf])
}

function crc32Table() {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (1 + SIZE * 4)
  raw[rowStart] = 0 // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const [r, g, b, a] = pixel(x, y)
    const offset = rowStart + 1 + x * 4
    raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a
  }
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
const iconDir = Buffer.alloc(22)
iconDir.writeUInt16LE(0, 0)
iconDir.writeUInt16LE(1, 2)
iconDir.writeUInt16LE(1, 4)
iconDir[6] = 0; iconDir[7] = 0; iconDir[8] = 0; iconDir[9] = 0
iconDir.writeUInt16LE(1, 10)
iconDir.writeUInt16LE(32, 12)
iconDir.writeUInt32LE(png.length, 14)
iconDir.writeUInt32LE(22, 18)
const ico = Buffer.concat([iconDir, png])
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
writeFileSync(join(dirname(outPath), 'icon.ico'), ico)
console.log(`icon written: ${outPath} (${png.length} bytes); build/icon.ico (${ico.length} bytes)`)
