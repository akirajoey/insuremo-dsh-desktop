import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, copyFileSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'

const appPath = process.argv[2]
const sourceRuntimePath = process.argv[3]
if (appPath === undefined || appPath === '') throw new Error('usage: node finalize-e07-signature.mjs <app-path> [source-runtime-root]')
const manifestPath = join(appPath, 'Contents/Resources/dsh-runtime/manifest.json')
if (!existsSync(manifestPath)) throw new Error(`runtime manifest missing: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const root = join(appPath, 'Contents/Resources/dsh-runtime')
if (sourceRuntimePath !== undefined) {
  for (const name of ['icon.png', 'runtime-pins.json']) {
    const source = join(sourceRuntimePath, name)
    const target = join(root, name)
    if (!existsSync(source)) throw new Error(`source runtime extra missing: ${name}`)
    copyFileSync(source, target)
    if (!manifest.files.some(entry => entry.path === name)) manifest.files.push({ path: name, kind: 'file', size: 0, sha256: '' })
  }
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function resourcePath(value) {
  const normalized = normalize(value)
  if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('\\')) throw new Error(`unsafe manifest path: ${value}`)
  const resolved = resolve(root, normalized)
  if (relative(root, resolved).startsWith('..')) throw new Error(`unsafe manifest path: ${value}`)
  return resolved
}

manifest.files = manifest.files.filter(entry => {
  if (entry.path.endsWith('/.modules.yaml') || entry.path === '.modules.yaml') {
    const ignored = resourcePath(entry.path)
    if (existsSync(ignored)) unlinkSync(ignored)
    return false
  }
  return true
})

for (const entry of manifest.files) {
  const path = resourcePath(entry.path)
  if (!existsSync(path)) throw new Error(`signed resource missing: ${entry.path}`)
  const link = lstatSync(path)
  if (link.isSymbolicLink()) {
    const target = readlinkSync(path)
    if (!existsSync(path)) throw new Error(`signed resource symlink is broken: ${entry.path}`)
    entry.kind = 'symlink'
    entry.target = target
    entry.size = Buffer.byteLength(target)
    entry.sha256 = hashText(target)
  } else {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error(`signed resource is not a file: ${entry.path}`)
    entry.kind = 'file'
    delete entry.target
    entry.size = stat.size
    entry.sha256 = hashFile(path)
  }
}
const workbench = resourcePath(manifest.workbench.path)
manifest.workbench.sha256 = hashFile(workbench)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const inspected = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' })
const details = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`
const identity = process.env.E07_SIGNING_IDENTITY ?? details.match(/^Authority=(.+)$/m)?.[1]
if (identity !== undefined && identity !== '') {
  execFileSync('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
  console.log(JSON.stringify({ appPath, signed: true, identity, manifestPath }, null, 2))
} else {
  console.log(JSON.stringify({ appPath, signed: false, manifestPath, note: 'No signing identity supplied; unsigned dev package remains intentionally unsigned.' }, null, 2))
}
