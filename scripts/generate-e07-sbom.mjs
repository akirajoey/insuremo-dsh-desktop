import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = resolve(process.argv[2] ?? join(root, 'packaging/e07/runtime'))
const outputPath = process.argv[3] === undefined ? 'docs/evidence/e07-sbom.json' : process.argv[3]
const manifestPath = join(runtimeRoot, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error('prepare:e07:resources must run first')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function packageRecords() {
  const records = new Map()
  const pnpmRoot = join(runtimeRoot, 'harness/node_modules/.pnpm')
  for (const folder of readdirSync(pnpmRoot)) {
    const packageNodeModules = join(pnpmRoot, folder, 'node_modules')
    if (!existsSync(packageNodeModules) || !lstatSync(packageNodeModules).isDirectory()) continue
    for (const scopeOrName of readdirSync(packageNodeModules)) {
      const scopePath = join(packageNodeModules, scopeOrName)
      const names = scopeOrName.startsWith('@') && lstatSync(scopePath).isDirectory()
        ? readdirSync(scopePath).map(name => join(scopeOrName, name))
        : [scopeOrName]
      for (const packageName of names) {
        const packageJsonPath = join(packageNodeModules, packageName, 'package.json')
        if (!existsSync(packageJsonPath)) continue
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
          if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
          records.set(`${pkg.name}@${pkg.version}`, {
            name: pkg.name,
            version: pkg.version,
            license: pkg.license ?? pkg.licenses ?? null,
            private: pkg.private === true,
          })
        } catch {
          // An individual malformed metadata file is reported by resource
          // hashing; it is not silently included in the package inventory.
        }
      }
    }
  }
  return [...records.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}

function nativeFiles() {
  const files = []
  const visit = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const link = lstatSync(path)
      if (link.isSymbolicLink()) continue
      if (link.isDirectory()) visit(path)
      else if (/\.(?:node|dll|exe|dylib)$/u.test(name) || name === 'spawn-helper') {
        const stat = statSync(path)
        files.push({ path: relative(runtimeRoot, path).split('\\').join('/'), size: stat.size, sha256: sha256(path) })
      }
    }
  }
  visit(runtimeRoot)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packages = packageRecords()
const sbom = {
  schema: 'CycloneDX-like inventory v1',
  generatedBy: 'scripts/generate-e07-sbom.mjs',
  runtime: {
    harness: '@deepseek-ai/dsh',
    version: manifest.runtimeVersion,
    nodeVersion: manifest.nodeVersion,
    nodeMode: manifest.nodeMode ?? 'bundled',
    targetArch: manifest.runtimeArch,
    resourceManifestSha256: sha256(manifestPath),
    resourceFileCount: manifest.files.length,
    workbenchSha256: manifest.workbench.sha256,
  },
  direct: {
    electron: '43.4.0',
    electronBuilder: '26.0.12',
    pnpm: '11.7.0',
    react: '18.3.1',
    vite: '6.4.3',
    typescript: '5.8.3',
    vitest: '3.1.2',
  },
  components: packages,
  nativeFiles: nativeFiles(),
  unknownLicenseComponents: packages.filter(pkg => pkg.license === null).map(pkg => `${pkg.name}@${pkg.version}`),
}
const output = resolve(root, outputPath)
writeFileSync(output, JSON.stringify(sbom, null, 2) + '\n')
console.log(JSON.stringify({ output: outputPath, components: packages.length, nativeFiles: sbom.nativeFiles.length, unknownLicenses: sbom.unknownLicenseComponents.length, resourceFileCount: manifest.files.length }, null, 2))
