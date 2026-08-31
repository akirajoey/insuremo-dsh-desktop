/**
 * Assemble the application icon set from the single active design source
 * (design/insuremo-dsh-glass-icon-v2-imo.png, hash-pinned below).
 *
 * - build/icon.png  — the committed 1024x1024 derivative (dock, BrowserWindow,
 *   menu, and electron-builder's icns input).
 * - build/icon.ico  — a Windows ICO assembled from the committed PNG ladder
 *   (16..256 PNG-embedded entries), pure-Node and byte-deterministic.
 *
 * The script uses repository-relative paths only, performs no image
 * processing (derivatives are committed under design/icons/), and has no
 * dependency on sips, Pillow, or ImageMagick, so output is identical on
 * macOS and Windows.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ICON_SOURCE = 'design/insuremo-dsh-glass-icon-v2-imo.png'
export const ICON_SOURCE_SHA256 = 'aa84a60fbfcdc99eb69c8b458d1952d1cb2b3db7f51dc8659d8dfbe88b058b8d'
export const ICON_SOURCE_SIZE = 1254
export const ICON_PNG_SIZE = 1024
export const ICO_LADDER = [16, 24, 32, 48, 64, 128, 256]

/** Committed derivative pins (sha256 of each design/icons/icon-<size>.png). */
export const ICON_DERIVATIVE_SHA256 = {
  16: 'ca56a4b15b7e601d9e203dcc7183f50ae0b98471ca8c8e15ea8b02458cd83014',
  24: '35ea627fbf85a0e0b2b957480f4c954473483a78acfd568becebe4d9efe61240',
  32: '910c57930c147356404f157410ec88afafafab5dc0ca2719ae53569e9f8b7923',
  48: '5c79255b2ff66966b62711161655225827de013dac54b9803c98f3bde6728ac3',
  64: 'c1737b7ba92972813db7a097abb2b588d14d85cef0626bce1b0f07104ad72425',
  128: '81adda616e416e3906b7e4abb37de27434c068bbc08015023d1853797d3334e6',
  256: '96de57faeba2b6ae3d7792fcea903f4b58904e2fdd5d7fb70bce5b2cbe4a8bc7',
  512: 'e276275da99c42741370a5b59f45718e0ca8bc0da7bb24c28e8a10af484e2ca8',
  1024: '0e4408ad7bf8356f2c3896be04a901fc182f3b3b639989f8072d515d9a39413b',
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read PNG dimensions and color metadata without any image dependency. */
export function pngInfo(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 29 || !bytes.subarray(0, 8).equals(signature)) throw new Error('not a PNG file')
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG IHDR chunk missing')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    compression: bytes[26],
    filter: bytes[27],
    interlace: bytes[28],
  }
}

/** Read a PNG's IHDR width/height without any image dependency. */
export function pngSize(bytes) {
  const { width, height } = pngInfo(bytes)
  return { width, height }
}

/** Read one alpha sample from an 8-bit RGBA, non-interlaced PNG. */
export function pngAlphaAt(bytes, x, y) {
  const { width, height, bitDepth, colorType, interlace } = pngInfo(bytes)
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) throw new Error('PNG must be 8-bit RGBA non-interlaced')
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) throw new Error(`PNG sample out of bounds: ${x},${y}`)
  let offset = 8
  const idat = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const stride = width * 4
  const filtered = inflateSync(Buffer.concat(idat))
  let input = 0
  let previous = Buffer.alloc(stride)
  for (let rowIndex = 0; rowIndex <= y; rowIndex++) {
    const filter = filtered[input++]
    const row = Buffer.from(filtered.subarray(input, input + stride))
    input += stride
    unfilterPngRow(row, previous, filter, 4)
    if (rowIndex === y) return row[x * 4 + 3]
    previous = row
  }
  throw new Error('PNG row missing')
}

function unfilterPngRow(row, previous, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
    const above = previous[i]
    const upperLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0
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
}

function readLadderPng(size) {
  const path = join(root, 'design', 'icons', `icon-${size}.png`)
  const bytes = readFileSync(path)
  const digest = sha256(bytes)
  if (digest !== ICON_DERIVATIVE_SHA256[size]) throw new Error(`icon derivative hash mismatch: icon-${size}.png ${digest}`)
  const { width, height, bitDepth, colorType, compression, filter, interlace } = pngInfo(bytes)
  if (width !== size || height !== size) throw new Error(`icon derivative dimension mismatch: icon-${size}.png is ${width}x${height}`)
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) throw new Error(`icon derivative must be 8-bit RGBA non-interlaced: icon-${size}.png`)
  return bytes
}

/** Verify the pinned design source and read the committed derivative ladder. */
export function verifyDesignAssets() {
  const sourceBytes = readFileSync(join(root, ICON_SOURCE))
  const digest = sha256(sourceBytes)
  if (digest !== ICON_SOURCE_SHA256) throw new Error(`design source hash mismatch: ${digest}`)
  const { width, height, bitDepth, colorType, compression, filter, interlace } = pngInfo(sourceBytes)
  if (width !== ICON_SOURCE_SIZE || height !== ICON_SOURCE_SIZE) throw new Error(`design source must be ${ICON_SOURCE_SIZE}x${ICON_SOURCE_SIZE}, got ${width}x${height}`)
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) throw new Error('design source must be 8-bit RGBA non-interlaced')
  const ladder = {}
  for (const size of Object.keys(ICON_DERIVATIVE_SHA256).map(Number)) ladder[size] = readLadderPng(size)
  return { sourceBytes, ladder, sourceSha256: digest }
}

/** Assemble a PNG-embedded Windows ICO; entries must be square PNGs. */
export function assembleIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  const payloads = []
  entries.forEach(({ size, bytes }, index) => {
    const { width, height } = pngSize(bytes)
    if (width !== size || height !== size) throw new Error(`ICO entry ${size} payload is ${width}x${height}`)
    const base = index * 16
    directory[base] = size >= 256 ? 0 : size // 0 encodes 256
    directory[base + 1] = size >= 256 ? 0 : size
    directory[base + 2] = 0 // palette
    directory[base + 3] = 0 // reserved
    directory.writeUInt16LE(1, base + 4) // color planes
    directory.writeUInt16LE(32, base + 6) // bits per pixel
    directory.writeUInt32LE(bytes.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    payloads.push(bytes)
    offset += bytes.length
  })
  return Buffer.concat([header, directory, ...payloads])
}

function main() {
  const { ladder } = verifyDesignAssets()
  const buildDir = join(root, 'build')
  mkdirSync(buildDir, { recursive: true })
  const iconPng = ladder[ICON_PNG_SIZE]
  copyFileSync(join(root, 'design', 'icons', `icon-${ICON_PNG_SIZE}.png`), join(buildDir, 'icon.png'))
  const ico = assembleIco(ICO_LADDER.map(size => ({ size, bytes: ladder[size] })))
  writeFileSync(join(buildDir, 'icon.ico'), ico)
  console.log(`icon written: build/icon.png (${iconPng.length} bytes, ${ICON_PNG_SIZE}x${ICON_PNG_SIZE}); build/icon.ico (${ico.length} bytes, ${ICO_LADDER.join('/')}) from ${ICON_SOURCE} sha256 ${ICON_SOURCE_SHA256.slice(0, 12)}…`)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
