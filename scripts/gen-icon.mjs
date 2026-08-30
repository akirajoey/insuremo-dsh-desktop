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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ICON_SOURCE = 'design/insuremo-dsh-glass-icon-v2-imo.png'
export const ICON_SOURCE_SHA256 = '6fb21082817bfcd7cfffe57e791bd4e11467561db71a2d7a17d772fd971188c7'
export const ICON_SOURCE_SIZE = 1254
export const ICON_PNG_SIZE = 1024
export const ICO_LADDER = [16, 24, 32, 48, 64, 128, 256]

/** Committed derivative pins (sha256 of each design/icons/icon-<size>.png). */
export const ICON_DERIVATIVE_SHA256 = {
  16: 'aa335327471b1b2697a2da8dc4f8d031bd11502c91a1825e818242401fd78ad0',
  24: 'd945e2206c674a4d4423ec16d1a326d5416e98796b5f33caf025e653dcf7db37',
  32: 'e8a9bb2dcf98a24477763c7a88bb9590c86c7eae23848fef321ef82a14d575c1',
  48: '2f2d78872b57212b2e0fa62d8e7f3b5dc41fa6c76f3ab25cfefcf94753b80f1a',
  64: '62eb5069e5fb6d94f26e0481937f512cb74201e9f941f7d42c69bb69ba6798d8',
  128: '2311b5954ca187bd083d6f8e0b9a9e632cf09786609c419b86362797d451aab3',
  256: 'b1af57f75c60388a49cae3f7d6f6711b8c0fff79f615285d8fe9b41d85de6d86',
  512: 'e3dafb46b4291b4f4c849fc3cf071c05fbf5bfbb05ee797b7af5cda698e69500',
  1024: '2bf50b3d37f7dbe6b0b24b8a69aee4e9da51bf95f9bb38dc58cef55dc1b3d4b6',
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read a PNG's IHDR width/height without any image dependency. */
export function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) throw new Error('not a PNG file')
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG IHDR chunk missing')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function readLadderPng(size) {
  const path = join(root, 'design', 'icons', `icon-${size}.png`)
  const bytes = readFileSync(path)
  const digest = sha256(bytes)
  if (digest !== ICON_DERIVATIVE_SHA256[size]) throw new Error(`icon derivative hash mismatch: icon-${size}.png ${digest}`)
  const { width, height } = pngSize(bytes)
  if (width !== size || height !== size) throw new Error(`icon derivative dimension mismatch: icon-${size}.png is ${width}x${height}`)
  return bytes
}

/** Verify the pinned design source and read the committed derivative ladder. */
export function verifyDesignAssets() {
  const sourceBytes = readFileSync(join(root, ICON_SOURCE))
  const digest = sha256(sourceBytes)
  if (digest !== ICON_SOURCE_SHA256) throw new Error(`design source hash mismatch: ${digest}`)
  const { width, height } = pngSize(sourceBytes)
  if (width !== ICON_SOURCE_SIZE || height !== ICON_SOURCE_SIZE) throw new Error(`design source must be ${ICON_SOURCE_SIZE}x${ICON_SOURCE_SIZE}, got ${width}x${height}`)
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
