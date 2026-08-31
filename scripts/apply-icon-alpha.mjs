/**
 * One-time, dependency-free alpha mask application for the active IMO icon.
 * This is intentionally not called by the build: derivatives are committed
 * and scripts/gen-icon.mjs only verifies/copies them.
 *
 * Mask geometry: a fourth-order superellipse centered at the pixel-center
 * midpoint (626.5, 626.5), with a 10px inset (radius 616.5px). Alpha fades
 * over a 3px outward feather: alpha = clamp((signedDistance + 3) / 3),
 * where the superellipse boundary has signedDistance 0. Thus the boundary
 * pixel is fully opaque while the outside transition is antialiased.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'design/insuremo-dsh-glass-icon-v2-imo.png')
const ORDER = 4
const INSET = 10
const FEATHER = 3

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const tag = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  tag.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([tag, data])), 8 + data.length)
  return out
}

function decodeRgbPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not a PNG')
  let offset = 8
  let ihdr
  const idat = []
  const ancillary = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type !== 'IEND') ancillary.push(chunk(type, data))
  }
  if (ihdr === undefined || ihdr[8] !== 8 || ihdr[9] !== 2 || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) throw new Error('expected non-interlaced 8-bit RGB PNG')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const stride = width * 3
  const filtered = inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(width * height * 3)
  let input = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = filtered[input++]
    const row = Buffer.from(filtered.subarray(input, input + stride))
    input += stride
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? row[i - 3] : 0
      const above = previous[i]
      const upperLeft = i >= 3 ? previous[i - 3] : 0
      if (filter === 1) row[i] = (row[i] + left) & 255
      else if (filter === 2) row[i] = (row[i] + above) & 255
      else if (filter === 3) row[i] = (row[i] + Math.floor((left + above) / 2)) & 255
      else if (filter === 4) {
        const estimate = left + above - upperLeft
        const pa = Math.abs(estimate - left)
        const pb = Math.abs(estimate - above)
        const pc = Math.abs(estimate - upperLeft)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 255
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`)
    }
    row.copy(rgb, y * stride)
    previous = row
  }
  return { width, height, rgb, ancillary }
}

function alphaAt(x, y, width, height) {
  const centerX = (width - 1) / 2
  const centerY = (height - 1) / 2
  const radiusX = centerX - INSET
  const radiusY = centerY - INSET
  const dx = Math.abs(x + 0.5 - centerX) / radiusX
  const dy = Math.abs(y + 0.5 - centerY) / radiusY
  const superRadius = (dx ** ORDER + dy ** ORDER) ** (1 / ORDER)
  const signedDistance = (1 - superRadius) * Math.min(radiusX, radiusY)
  return Math.max(0, Math.min(255, Math.round(((signedDistance + FEATHER) / FEATHER) * 255)))
}

function encodeRgbaPng({ width, height, rgb, ancillary }) {
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y++) {
    scanlines[offset++] = 0
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 3
      scanlines[offset++] = rgb[source]
      scanlines[offset++] = rgb[source + 1]
      scanlines[offset++] = rgb[source + 2]
      scanlines[offset++] = alphaAt(x, y, width, height)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...ancillary, chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]
  return Buffer.concat(png)
}

function main() {
  const original = readFileSync(sourcePath)
  const decoded = decodeRgbPng(original)
  const updated = encodeRgbaPng(decoded)
  writeFileSync(sourcePath, updated)
  console.log(JSON.stringify({
    path: 'design/insuremo-dsh-glass-icon-v2-imo.png',
    width: decoded.width,
    height: decoded.height,
    order: ORDER,
    inset: INSET,
    feather: FEATHER,
    sha256: createHash('sha256').update(updated).digest('hex'),
    samples: Object.fromEntries([[0, 0], [decoded.width - 1, 0], [Math.floor(decoded.width / 2), 0], [Math.floor(decoded.width / 2), 7], [Math.floor(decoded.width / 2), 8], [Math.floor(decoded.width / 2), 9], [Math.floor(decoded.width / 2), 10], [Math.floor(decoded.width / 2), 20], [10, Math.floor(decoded.height / 2)], [Math.floor(decoded.width / 2), Math.floor(decoded.height / 2)]].map(([x, y]) => [`${x},${y}`, alphaAt(x, y, decoded.width, decoded.height)])),
  }, null, 2))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
