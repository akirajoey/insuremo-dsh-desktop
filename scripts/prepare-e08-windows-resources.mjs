import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, relative, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '24.9.0'
const arch = 'x64'
const nodeSha256 = '6873514c3e6a012917cc6f95ce48a6289253370d025f1b69db290d70feebfa6e'
const runtimeRoot = join(root, 'packaging/e08/runtime')
const cacheRoot = join(root, 'packaging/e08/cache')
const nodeCache = join(cacheRoot, 'node')
const workbenchPath = process.env.DSH_WORKBENCH_TGZ
const supervisorPath = process.env.DSH_WINDOWS_SUPERVISOR_EXE ?? join(root, 'packaging/e08/runtime-supervisor/runtime-supervisor.exe')
if (workbenchPath === undefined || !existsSync(workbenchPath)) throw new Error('DSH_WORKBENCH_TGZ must point to the verified Workbench tgz')
if (!existsSync(supervisorPath)) throw new Error(`Windows supervisor missing: ${supervisorPath}`)

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function commandPath(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return execFileSync(lookup, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/u)[0]
}
function resolvePath(path) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'realpath', [path], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0] } catch { return resolve(path) }
}
async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`)
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}
function extractZip(archive, destination) {
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`
    const command = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit', windowsHide: true })
  } else {
    execFileSync('unzip', ['-q', archive, '-d', destination], { stdio: 'inherit' })
  }
}
async function prepareNode() {
  const archive = join(nodeCache, `node-v${version}-win-${arch}.zip`)
  mkdirSync(nodeCache, { recursive: true })
  if (!existsSync(archive) || sha256(archive) !== nodeSha256) await download(`https://nodejs.org/dist/v${version}/node-v${version}-win-${arch}.zip`, archive)
  if (sha256(archive) !== nodeSha256) throw new Error('Node win-x64 SHA256 mismatch')
  const extract = mkdtempSync(join(tmpdir(), 'dsh-node-win-'))
  try {
    extractZip(archive, extract)
    const source = join(extract, `node-v${version}-win-${arch}`)
    const target = join(runtimeRoot, 'node/win32-x64')
    mkdirSync(target, { recursive: true })
    copyFileSync(join(source, 'node.exe'), join(target, 'node.exe'))
    for (const file of ['LICENSE', 'README.md']) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file))
  } finally { rmSync(extract, { recursive: true, force: true }) }
}
function preparePnpm() {
  const shim = commandPath('pnpm')
  const real = resolvePath(shim)
  const candidates = [
    resolve(dirname(real)),
    resolve(dirname(real), '..'),
    resolve(dirname(real), 'node_modules/pnpm'),
    resolve(dirname(real), '..', 'node_modules/pnpm'),
    resolve(dirname(real), '..', 'lib/node_modules/pnpm'),
  ]
  const pnpmRoot = candidates.find(path => existsSync(join(path, 'bin/pnpm.cjs')) && existsSync(join(path, 'dist/pnpm.mjs')))
  if (pnpmRoot === undefined) throw new Error('pnpm 11 JavaScript entry/package is incomplete')
  cpSync(pnpmRoot, join(runtimeRoot, 'pnpm'), { recursive: true, dereference: true })
  return join(runtimeRoot, 'pnpm/bin/pnpm.cjs')
}
function prepareHarness(pnpmEntry) {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-runtime-win-'))
  try {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const dependencies = {}
    for (const name of ['@deepseek-ai/dsh', 'react', 'react-dom']) {
      const value = rootPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name]
      if (typeof value !== 'string') throw new Error(`runtime dependency missing: ${name}`)
      dependencies[name] = value
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'insuremo-dsh-runtime', version: rootPackage.version, private: true, type: 'module', dependencies }, null, 2) + '\n')
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFileSync(join(root, file), join(stage, file))
    execFileSync(process.execPath, [pnpmEntry, 'install', '--prod', '--no-frozen-lockfile', '--config.block-exotic-subdeps=false', '--cpu', arch, '--os', 'win32', '--ignore-scripts'], { cwd: stage, stdio: 'inherit', env: { ...process.env, CI: '1' } })
    const harnessRoot = join(runtimeRoot, 'harness')
    mkdirSync(harnessRoot, { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFileSync(join(stage, file), join(harnessRoot, file))
    cpSync(join(stage, 'node_modules'), join(harnessRoot, 'node_modules'), { recursive: true, dereference: true })
    copyFileSync(join(root, 'src/main/runtime/wrapper.cjs'), join(harnessRoot, 'wrapper.cjs'))
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
function removeNoise(current) {
  const excluded = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'fixtures'])
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const info = lstatSync(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (excluded.has(name)) rmSync(path, { recursive: true, force: true }); else removeNoise(path)
    } else if (info.isFile() && (name === '.modules.yaml' || name.endsWith('.map') || /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(name))) rmSync(path, { force: true })
  }
}
function shaText(value) { return createHash('sha256').update(value).digest('hex') }
function walk(current, base = current) {
  const result = []
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const rel = relative(base, path).split('\\').join('/')
    const info = lstatSync(path)
    if (info.isSymbolicLink()) { result.push({ path: rel, kind: 'symlink', target: readlinkSync(path), size: Buffer.byteLength(readlinkSync(path)), sha256: shaText(readlinkSync(path)) }); continue }
    if (info.isDirectory()) { result.push(...walk(path, base)); continue }
    result.push({ path: rel, kind: 'file', size: statSync(path).size, sha256: sha256(path) })
  }
  return result
}
const workbenchSha256 = sha256(workbenchPath)
rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(runtimeRoot, { recursive: true })
for (const file of ['config/runtime-pins.json', 'build/icon.png', 'build/icon.ico']) copyFileSync(join(root, file), join(runtimeRoot, file.split('/').at(-1)))
await prepareNode()
const pnpmEntry = preparePnpm()
prepareHarness(pnpmEntry)
removeNoise(runtimeRoot)
mkdirSync(join(runtimeRoot, 'workbench'), { recursive: true })
copyFileSync(workbenchPath, join(runtimeRoot, 'workbench/icomposer-workbench.tgz'))
mkdirSync(join(runtimeRoot, 'supervisor'), { recursive: true })
copyFileSync(supervisorPath, join(runtimeRoot, 'supervisor/runtime-supervisor.exe'))
const files = walk(runtimeRoot).sort((a, b) => a.path.localeCompare(b.path))
const manifest = { schemaVersion: 1, runtimeVersion: '0.1.0-rc.7', nodeVersion: version, runtimeArch: arch, nodeMode: 'bundled', distribution: 'full-runtime', files, workbench: { path: 'workbench/icomposer-workbench.tgz', sha256: workbenchSha256 } }
writeFileSync(join(runtimeRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ runtimeRoot, targetArch: arch, nodeZipSha256: nodeSha256, pnpmEntry, fileCount: files.length, workbenchSha256, supervisor: 'supervisor/runtime-supervisor.exe' }, null, 2))
