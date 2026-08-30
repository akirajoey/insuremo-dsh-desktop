import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetArch = process.env.DSH_RUNTIME_ARCH ?? process.arch
if (targetArch !== 'arm64' && targetArch !== 'x64') throw new Error(`unsupported DSH_RUNTIME_ARCH: ${targetArch}`)
const runtimeRoot = join(root, 'packaging/e07/runtime')
const workbenchPath = process.env.DSH_WORKBENCH_TGZ
if (workbenchPath === undefined || !existsSync(workbenchPath)) {
  throw new Error('DSH_WORKBENCH_TGZ must point to the verified Workbench tgz')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function commandPath(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return execFileSync(lookup, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/u)[0]
}

function preparePnpm() {
  const shim = commandPath('pnpm')
  const real = resolvePath(shim)
  const pnpmRoot = resolve(dirname(real), '..')
  if (!existsSync(join(pnpmRoot, 'bin/pnpm.cjs')) || !existsSync(join(pnpmRoot, 'dist/pnpm.mjs'))) {
    throw new Error('pnpm 11 JavaScript entry/package is incomplete')
  }
  cpSync(pnpmRoot, join(runtimeRoot, 'pnpm'), { recursive: true, dereference: true })
  return join(runtimeRoot, 'pnpm/bin/pnpm.cjs')
}

function prepareHarness(pnpmEntry) {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-runtime-prod-'))
  try {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const runtimeDependencies = {}
    for (const name of ['@deepseek-ai/dsh', 'react', 'react-dom']) {
      const versionSpec = rootPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name]
      if (typeof versionSpec !== 'string') throw new Error(`runtime dependency missing: ${name}`)
      runtimeDependencies[name] = versionSpec
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: 'insuremo-dsh-runtime',
      version: rootPackage.version,
      private: true,
      type: 'module',
      dependencies: runtimeDependencies,
    }, null, 2) + '\n')
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      copyFileSync(join(root, file), join(stage, file))
    }
    const installArgs = ['install', '--prod', '--no-frozen-lockfile', '--config.block-exotic-subdeps=false', '--cpu', targetArch, '--os', 'darwin']
    if (process.arch !== targetArch) installArgs.push('--ignore-scripts')
    execFileSync(process.execPath, [pnpmEntry, ...installArgs], {
      cwd: stage,
      stdio: 'inherit',
      env: { ...process.env, CI: '1' },
    })
    const harnessRoot = join(runtimeRoot, 'harness')
    mkdirSync(harnessRoot, { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      if (existsSync(join(stage, file))) copyFileSync(join(stage, file), join(harnessRoot, file))
    }
    cpSync(join(stage, 'node_modules'), join(harnessRoot, 'node_modules'), { recursive: true, dereference: false })
    rewriteCopiedSymlinks(join(harnessRoot, 'node_modules'), join(stage, 'node_modules'))
    copyFileSync(join(root, 'src/main/runtime/wrapper.cjs'), join(harnessRoot, 'wrapper.cjs'))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function rewriteCopiedSymlinks(destinationRoot, sourceRoot) {
  const destination = resolve(destinationRoot)
  const source = realpathSync(sourceRoot)
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const file = join(current, name)
      const link = lstatSync(file)
      if (link.isSymbolicLink()) {
        const target = readlinkSync(file)
        if (!isAbsolute(target)) continue
        const sourceTarget = realpathSync(target)
        if (!sourceTarget.startsWith(`${source}${sep}`)) throw new Error(`copied workspace symlink escapes stage: ${file}`)
        const destinationTarget = join(destination, relative(source, sourceTarget))
        unlinkSync(file)
        symlinkSync(relative(dirname(file), destinationTarget), file)
      } else if (link.isDirectory()) {
        visit(file)
      }
    }
  }
  visit(destination)
}

function resolvePath(path) {
  try {
    return execFileSync('realpath', [path], { encoding: 'utf8' }).trim()
  } catch {
    return resolve(path)
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function walk(rootDir, current = rootDir) {
  const entries = []
  for (const name of readdirSync(current)) {
    const file = join(current, name)
    const relativePath = relative(rootDir, file).split('\\').join('/')
    const link = lstatSync(file)
    if (link.isSymbolicLink()) {
      const target = readlinkSync(file)
      if (!existsSync(file)) throw new Error(`broken packaged runtime link: ${relativePath}`)
      entries.push({ path: relativePath, kind: 'symlink', target, size: Buffer.byteLength(target), sha256: sha256Text(target) })
      continue
    }
    if (link.isDirectory()) {
      entries.push(...walk(rootDir, file))
      continue
    }
    const stat = statSync(file)
    entries.push({ path: relativePath, kind: 'file', size: stat.size, sha256: sha256(file) })
  }
  return entries
}

function removePackagingNoise(rootDir) {
  const excludedDirs = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'fixtures'])
  const visit = current => {
    for (const name of readdirSync(current)) {
      const file = join(current, name)
      const link = lstatSync(file)
      if (link.isDirectory() && !link.isSymbolicLink()) {
        if (excludedDirs.has(name)) rmSync(file, { recursive: true, force: true })
        else visit(file)
      } else if (link.isFile() && (name === '.modules.yaml' || name.endsWith('.map') || /(?:^|\\.)(?:test|spec)\\.[^.]+$/u.test(name))) {
        rmSync(file, { force: true })
      }
    }
  }
  visit(rootDir)
}

function removeBuilderIgnoredFiles(rootDir) {
  const visit = current => {
    for (const name of readdirSync(current)) {
      const file = join(current, name)
      const link = lstatSync(file)
      if (link.isDirectory() && !link.isSymbolicLink()) visit(file)
      else if (name === '.gitkeep') rmSync(file, { force: true })
    }
  }
  visit(rootDir)
}

const workbenchSha256 = sha256(workbenchPath)
rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(runtimeRoot, { recursive: true })
copyFileSync(join(root, 'config/runtime-pins.json'), join(runtimeRoot, 'runtime-pins.json'))
copyFileSync(join(root, 'build/icon.png'), join(runtimeRoot, 'icon.png'))
// Darwin uses Electron 43's verified embedded Node 24.18.1 in run-as-Node
// mode; standalone Node binaries are intentionally not copied here.
const pnpmEntry = preparePnpm()
prepareHarness(pnpmEntry)
removePackagingNoise(runtimeRoot)
removeBuilderIgnoredFiles(runtimeRoot)
mkdirSync(join(runtimeRoot, 'workbench'), { recursive: true })
const bundledWorkbench = join(runtimeRoot, 'workbench', 'icomposer-workbench.tgz')
copyFileSync(workbenchPath, bundledWorkbench)
if (sha256(bundledWorkbench) !== workbenchSha256) throw new Error('copied Workbench SHA256 mismatch')
const files = walk(runtimeRoot).sort((a, b) => a.path.localeCompare(b.path))
const manifest = {
  schemaVersion: 1,
  runtimeVersion: '0.1.0-rc.7',
  nodeVersion: '24.18.1',
  runtimeArch: targetArch,
  nodeMode: 'electron-run-as-node',
  distribution: 'full-runtime',
  files,
  workbench: { path: 'workbench/icomposer-workbench.tgz', sha256: workbenchSha256 },
}
writeFileSync(join(runtimeRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ runtimeRoot, targetArch, nodeMode: 'electron-run-as-node', pnpmEntry: relative(root, pnpmEntry), fileCount: files.length, workbenchSha256 }, null, 2))
