import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePnpmEntry } from './resolve-pnpm-entry.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pins = JSON.parse(readFileSync(join(root, 'config/runtime-pins.json'), 'utf8'))
const version = pins.version
const pnpmEntry = resolvePnpmEntry()
const outputPath = process.env.DSH_SIZE_OUTPUT ?? 'docs/evidence/e07-runtime-size.json'
const probeRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-size-'))
const overrides = Object.fromEntries((pins.packages ?? []).map(name => [name, version]))

function runPnpm(directory, args) {
  execFileSync(process.execPath, [pnpmEntry, ...args], {
    cwd: directory,
    stdio: 'ignore',
    env: { ...process.env, CI: '1' },
  })
}

function logicalBytes(path) {
  if (!existsSync(path)) return 0
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return Buffer.byteLength(readlinkSync(path))
  if (info.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + logicalBytes(join(path, name)), 0)
  return statSync(path).size
}

function packageInventory(directory) {
  const packageRoot = join(directory, 'node_modules')
  const packages = new Set()
  if (!existsSync(packageRoot)) return packages
  const visit = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const info = lstatSync(path)
      const manifest = join(path, 'package.json')
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
          if (typeof pkg.name === 'string' && typeof pkg.version === 'string') packages.add(`${pkg.name}@${pkg.version}`)
        } catch { /* malformed package metadata is not counted */ }
      }
      if (info.isDirectory() && !info.isSymbolicLink()) visit(path)
    }
  }
  visit(packageRoot)
  return packages
}

function installProbe(name, dependencies) {
  const directory = join(probeRoot, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: `dsh-runtime-size-${name}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2) + '\n')
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), `packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\noverrides:\n${Object.entries(overrides).map(([pkg, pin]) => `  '${pkg}': ${pin}`).join('\n')}\n`)
  runPnpm(directory, ['install', '--prod', '--no-frozen-lockfile', '--ignore-scripts', '--config.block-exotic-subdeps=false', '--cpu', process.arch, '--os', 'darwin'])
  const packages = packageInventory(directory)
  return {
    direct: Object.keys(dependencies),
    packageCount: packages.size,
    nodeModulesBytes: logicalBytes(join(directory, 'node_modules')),
    packageNames: [...packages].sort(),
  }
}

function existingTree(path) {
  return existsSync(path) ? { bytes: logicalBytes(path) } : { bytes: 0 }
}

try {
  const result = {
    schema: 'DSH runtime size evidence v1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpmEntry: 'bundled/host pnpm 11.7.0 JS entry',
    runtimeVersion: version,
    probes: {
      minimalAnchors: installProbe('minimal-anchors', {
        '@deepseek-ai/dsh-app-boot': version,
        '@deepseek-ai/dsh-base': version,
        '@deepseek-ai/dsh-web-app': version,
      }),
      umbrella: installProbe('umbrella-dsh', {
        '@deepseek-ai/dsh': version,
        react: '18.3.1',
        'react-dom': '18.3.1',
      }),
    },
    currentPackagedArm64: {
      app: existingTree(join(root, 'release/mac-arm64-signed/InsureMO DSH Desktop.app')),
      runtime: existingTree(join(root, 'packaging/e07/runtime')),
      harness: existingTree(join(root, 'packaging/e07/runtime/harness')),
      framework: existingTree(join(root, 'release/mac-arm64-signed/InsureMO DSH Desktop.app/Contents/Frameworks')),
      nodeTargets: {
        arm64: existingTree(join(root, 'packaging/e07/runtime/node/darwin-arm64')),
        x64: existingTree(join(root, 'packaging/e07/runtime/node/darwin-x64')),
      },
    },
  }
  const output = resolve(root, outputPath)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ output: outputPath, minimalPackages: result.probes.minimalAnchors.packageCount, umbrellaPackages: result.probes.umbrella.packageCount, minimalBytes: result.probes.minimalAnchors.nodeModulesBytes, umbrellaBytes: result.probes.umbrella.nodeModulesBytes }, null, 2))
} finally {
  rmSync(probeRoot, { recursive: true, force: true })
}
