/**
 * Assemble the application icon set from the single active design source
 * (design/insuremo-dsh-elephant.png, hash-pinned below).
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
export const ICON_SOURCE = 'design/insuremo-dsh-elephant.png'
export const ICON_SOURCE_SHA256 = '8a801e66a5ec87b977d0f2e3dc57d27077508f506a325cee0168c27ae887ee67'
export const ICON_SOURCE_ARCHIVE = 'design/archive/elephant-download-rgb.png'
export const ICON_SOURCE_ARCHIVE_SHA256 = '190e7d1093a0df6cd784dfb1e34741a92ce7a3992ef08d4024e97548d1fadd93'
export const ICON_SOURCE_SIZE = 1254
export const ICON_PNG_SIZE = 1024
export const ICO_LADDER = [16, 24, 32, 48, 64, 128, 256]

/** Committed derivative pins (sha256 of each design/icons/icon-<size>.png). */
export const ICON_DERIVATIVE_SHA256 = {
  16: 'ef3bd51c475168e55b44b676872a070498bfde545833608dac95cd22506d0f89',
  24: '96ce51004b09cf6a17c20f1e8653b01f98cc3d1617c09d4f098f1d70abe2fc7a',
  32: 'ef78bb6ef6d90b748151709495b3a20f71b8f088a00c3df2f283b685507a1cbd',
  48: '96ca0392110985eeab3ed963135bbc3f0e52d0ec9377ba1c0b56ea55c1da797a',
  64: '9934b5959d03356cfa785387818f8e21c3d094d2c7b2509619c372aef0e83fef',
  128: 'f2a2bf4e2d5402ec86dd4076b5c9a8c44bad852c6badfb2014f4740ab56d93e0',
  256: '93a50dd17b1f22e009cfe9c6f076e6de2091a10ba998dae625fa8358c29f74e7',
  512: '940449f6fa204f1af833978f54efd5ea8bc6f07fb48578640d256ad8a75c409d',
  1024: '04fe34ef0af2758feda525c7cd9d2c311ffb4336110bda05cd9cba0165961390',
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

/** Decode 8-bit RGB/RGBA pixels without any image dependency. */
export function decodePngPixels(bytes) {
  const { width, height, bitDepth, colorType, compression, filter: method, interlace } = pngInfo(bytes)
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || compression !== 0 || method !== 0 || interlace !== 0) {
    throw new Error('PNG must be 8-bit RGB/RGBA non-interlaced')
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const idat = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const filtered = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * channels)
  let input = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const rowFilter = filtered[input++]
    const row = Buffer.from(filtered.subarray(input, input + stride))
    input += stride
    unfilterPngRow(row, previous, rowFilter, channels)
    row.copy(pixels, y * stride)
    previous = row
  }
  if (input !== filtered.length) throw new Error('PNG scanline payload has trailing bytes')
  return { width, height, channels, pixels }
}

/** Read one alpha sample from an 8-bit RGBA, non-interlaced PNG. */
export function pngAlphaAt(bytes, x, y) {
  const decoded = decodePngPixels(bytes)
  if (decoded.channels !== 4) throw new Error('PNG must be 8-bit RGBA non-interlaced')
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= decoded.width || y < 0 || y >= decoded.height) throw new Error(`PNG sample out of bounds: ${x},${y}`)
  return decoded.pixels[(y * decoded.width + x) * decoded.channels + 3]
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

/** Verify the pinned source/archive and read the committed derivative ladder. */
export function verifyDesignAssets() {
  const archiveBytes = readFileSync(join(root, ICON_SOURCE_ARCHIVE))
  const archiveDigest = sha256(archiveBytes)
  if (archiveDigest !== ICON_SOURCE_ARCHIVE_SHA256) throw new Error(`archive source hash mismatch: ${archiveDigest}`)
  const sourceBytes = readFileSync(join(root, ICON_SOURCE))
  const digest = sha256(sourceBytes)
  if (digest !== ICON_SOURCE_SHA256) throw new Error(`design source hash mismatch: ${digest}`)
  const { width, height, bitDepth, colorType, compression, filter, interlace } = pngInfo(sourceBytes)
  if (width !== ICON_SOURCE_SIZE || height !== ICON_SOURCE_SIZE) throw new Error(`design source must be ${ICON_SOURCE_SIZE}x${ICON_SOURCE_SIZE}, got ${width}x${height}`)
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) throw new Error('design source must be 8-bit RGBA non-interlaced')
  const ladder = {}
  for (const size of Object.keys(ICON_DERIVATIVE_SHA256).map(Number)) ladder[size] = readLadderPng(size)
  return { sourceBytes, ladder, sourceSha256: digest, archiveSha256: archiveDigest }
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
