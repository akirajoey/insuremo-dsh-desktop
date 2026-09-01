/**
 * One-time, dependency-free alpha mask application for the active elephant icon.
 * The immutable RGB archive is always the input and the active RGBA source is
 * always the output, so this command is re-runnable and never damages the
 * attribution copy. It is intentionally not called by the build: derivatives
 * are committed and scripts/gen-icon.mjs only verifies/copies them.
 *
 * Mask geometry: a fourth-order superellipse centered at the pixel-center
 * midpoint of the centered 1082px artwork square (540.5, 540.5), with a
 * 10px inset (radius 530.5px). Alpha fades over a 3px outward feather:
 * alpha = clamp((signedDistance + 3) / 3), where the superellipse boundary
 * has signedDistance 0. Thus the boundary pixel is fully opaque while the
 * outside transition is antialiased. The output canvas remains 1254px and
 * the centered artwork leaves an additional 86px transparent margin.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const archivePath = join(root, 'design/archive/elephant-download-rgb.png')
const activePath = join(root, 'design/insuremo-dsh-elephant.png')
const ARCHIVE_SHA256 = '190e7d1093a0df6cd784dfb1e34741a92ce7a3992ef08d4024e97548d1fadd93'
const ORDER = 4
const INSET = 10
const FEATHER = 3
// Keep the entire artwork, but reserve the same optical safe area measured
// from the Teams reference. With even-sized pixels and the mask feather, the
// measured non-zero alpha bbox is 1067px (within the requested 1066–1072).
const ARTWORK_SIZE = 1082
const TARGET_FOOTPRINT = ARTWORK_SIZE - 2 * (INSET - FEATHER) - 1

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

function sinc(value) {
  if (value === 0) return 1
  const angle = Math.PI * value
  return Math.sin(angle) / angle
}

/** Lanczos-3 downsampling with cached separable contributions. */
function lanczos(value) {
  const distance = Math.abs(value)
  return distance >= 3 ? 0 : sinc(value) * sinc(value / 3)
}

function contributionTable(sourceSize, targetSize) {
  const scale = targetSize / sourceSize
  const filterScale = Math.min(1, scale)
  const support = 3 / filterScale
  return Array.from({ length: targetSize }, (_, target) => {
    const center = (target + 0.5) / scale - 0.5
    const first = Math.ceil(center - support)
    const last = Math.floor(center + support)
    const weights = new Map()
    for (let source = first; source <= last; source++) {
      const index = Math.max(0, Math.min(sourceSize - 1, source))
      const weight = lanczos((center - source) * filterScale)
      weights.set(index, (weights.get(index) ?? 0) + weight)
    }
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
    return [...weights.entries()].map(([index, weight]) => ({ index, weight: weight / total }))
  })
}

function resampleRgb({ width, height, rgb }, targetSize) {
  if (width !== height) throw new Error('icon artwork must be square')
  const horizontal = contributionTable(width, targetSize)
  const vertical = contributionTable(height, targetSize)
  const horizontalPass = Buffer.alloc(targetSize * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetSize; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let value = 0
        for (const part of horizontal[x]) value += rgb[(y * width + part.index) * 3 + channel] * part.weight
        horizontalPass[(y * targetSize + x) * 3 + channel] = Math.max(0, Math.min(255, Math.round(value)))
      }
    }
  }
  const output = Buffer.alloc(targetSize * targetSize * 3)
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let value = 0
        for (const part of vertical[y]) value += horizontalPass[(part.index * targetSize + x) * 3 + channel] * part.weight
        output[(y * targetSize + x) * 3 + channel] = Math.max(0, Math.min(255, Math.round(value)))
      }
    }
  }
  return output
}

function encodeRgbaPng({ width, height, rgb, ancillary }) {
  if (width !== height || ARTWORK_SIZE > width || TARGET_FOOTPRINT < 1066 || TARGET_FOOTPRINT > 1072) throw new Error('invalid optical icon geometry')
  const scaled = resampleRgb({ width, height, rgb }, ARTWORK_SIZE)
  const margin = (width - ARTWORK_SIZE) / 2
  if (!Number.isInteger(margin)) throw new Error('scaled artwork margin must be integral')
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y++) {
    scanlines[offset++] = 0
    for (let x = 0; x < width; x++) {
      const localX = x - margin
      const localY = y - margin
      const inside = localX >= 0 && localX < ARTWORK_SIZE && localY >= 0 && localY < ARTWORK_SIZE
      const source = inside ? (localY * ARTWORK_SIZE + localX) * 3 : 0
      scanlines[offset++] = inside ? scaled[source] : 0
      scanlines[offset++] = inside ? scaled[source + 1] : 0
      scanlines[offset++] = inside ? scaled[source + 2] : 0
      scanlines[offset++] = inside ? alphaAt(localX, localY, ARTWORK_SIZE, ARTWORK_SIZE) : 0
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
  const original = readFileSync(archivePath)
  const archiveSha256 = createHash('sha256').update(original).digest('hex')
  if (archiveSha256 !== ARCHIVE_SHA256) throw new Error(`archive source hash mismatch: ${archiveSha256}`)
  const decoded = decodeRgbPng(original)
  const updated = encodeRgbaPng(decoded)
  writeFileSync(activePath, updated)
  const margin = (decoded.width - ARTWORK_SIZE) / 2
  const bboxStart = margin + INSET - FEATHER
  const bboxEnd = decoded.width - bboxStart - 2
  const samples = [[0, 0], [decoded.width - 1, 0], [Math.floor(decoded.width / 2), bboxStart - 1], [Math.floor(decoded.width / 2), bboxStart], [Math.floor(decoded.width / 2), bboxStart + 1], [Math.floor(decoded.width / 2), bboxStart + 2], [Math.floor(decoded.width / 2), Math.floor(decoded.height / 2)]]
  const outputAlpha = (x, y) => x >= margin && x < margin + ARTWORK_SIZE && y >= margin && y < margin + ARTWORK_SIZE ? alphaAt(x - margin, y - margin, ARTWORK_SIZE, ARTWORK_SIZE) : 0
  console.log(JSON.stringify({
    archive: 'design/archive/elephant-download-rgb.png',
    archiveSha256,
    path: 'design/insuremo-dsh-elephant.png',
    width: decoded.width,
    height: decoded.height,
    artworkSize: ARTWORK_SIZE,
    artworkMargin: margin,
    targetFootprint: TARGET_FOOTPRINT,
    measuredAlphaBbox: { x: [bboxStart, bboxEnd], y: [bboxStart, bboxEnd], width: bboxEnd - bboxStart + 1, height: bboxEnd - bboxStart + 1 },
    order: ORDER,
    inset: INSET,
    feather: FEATHER,
    sha256: createHash('sha256').update(updated).digest('hex'),
    samples: Object.fromEntries(samples.map(([x, y]) => [`${x},${y}`, outputAlpha(x, y)])),
  }, null, 2))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
