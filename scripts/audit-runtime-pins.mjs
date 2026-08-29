import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const pins = JSON.parse(await readFile(resolve(root, 'config/runtime-pins.json'), 'utf8'))
const lock = parse(await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8'))
const workspace = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
const dshPattern = new RegExp(pins.packagePattern)
const cordisPattern = new RegExp(pins.nonDshCordisPattern)
const errors = []

function packageFromKey(key) {
  const match = key.match(/^(?<name>@[^/]+\/[^@]+|[^@]+)@(?<version>\d+\.\d+\.\d+(?:-[^()]+)?)(?:\(|$)/u)
  return match?.groups ?? {}
}

function addError(message) {
  errors.push(message)
}

const expected = new Set(pins.packages)
if (pins.version !== '0.1.0-rc.7') addError(`unexpected pin version ${pins.version}`)
if (expected.size !== pins.packages.length) addError('runtime pin list contains duplicates')

const lockVersions = new Map()
for (const key of Object.keys(lock.packages ?? {})) {
  const { name, version } = packageFromKey(key)
  if (!name || !version) continue
  if (dshPattern.test(name)) {
    if (!lockVersions.has(name)) lockVersions.set(name, new Set())
    lockVersions.get(name).add(version)
    if (version !== pins.version) addError(`lockfile ${name} is ${version}`)
  }
  if (cordisPattern.test(name) && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    addError(`non-DSH Cordis ${name} is not exact: ${version}`)
  }
}
for (const name of expected) {
  const versions = lockVersions.get(name)
  if (versions === undefined) addError(`lockfile is missing ${name}`)
}
for (const name of lockVersions.keys()) {
  if (!expected.has(name)) addError(`runtime pin list is missing lock package ${name}`)
}

const overrides = workspace.overrides ?? {}
for (const name of expected) {
  if (overrides[name] !== pins.version) addError(`override ${name} is ${JSON.stringify(overrides[name])}`)
}
const importer = lock.importers?.['.']
const directRecord = importer?.dependencies?.['@deepseek-ai/dsh'] ?? importer?.devDependencies?.['@deepseek-ai/dsh']
const direct = typeof directRecord === 'string' ? directRecord : directRecord?.version
if (typeof direct !== 'string' || !direct.startsWith(`${pins.version}(`) && direct !== pins.version) {
  addError(`direct DSH importer is ${JSON.stringify(direct)}`)
}

const installed = new Map()
async function inspectPackage(path) {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (!dshPattern.test(manifest.name ?? '')) return
    const key = `${manifest.name}@${manifest.version}`
    installed.set(key, (installed.get(key) ?? 0) + 1)
    if (manifest.version !== pins.version) addError(`node_modules ${manifest.name} is ${manifest.version}`)
  } catch {
    // A broken package.json is reported by the package manager; do not scan it twice.
  }
}

async function inspectDshDirectory(directory) {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectPackage(join(directory, entry.name, 'package.json'))
      }
    }
  } catch {
    // Optional virtual-store directories can disappear during install.
  }
}

await inspectDshDirectory(resolve(root, 'node_modules/@deepseek-ai'))
for (const entry of await readdir(resolve(root, 'node_modules/.pnpm'), { withFileTypes: true })) {
  if (entry.isDirectory()) await inspectDshDirectory(join(root, 'node_modules/.pnpm', entry.name, 'node_modules/@deepseek-ai'))
}
if (![...installed.keys()].some(key => key === `@deepseek-ai/dsh@${pins.version}`)) {
  addError('node_modules is missing @deepseek-ai/dsh')
}

if (process.argv.includes('--network')) {
  const names = [...expected]
  const checks = []
  for (let offset = 0; offset < names.length; offset += 8) {
    const group = names.slice(offset, offset + 8)
    checks.push(...await Promise.all(group.map(async name => {
      const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(url)
          const manifest = await response.json()
          if (response.ok && manifest.versions?.[pins.version] !== undefined) return [name, true]
        } catch {
          // Retry transient registry and connection failures below.
        }
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
      return [name, false]
    })))
  }
  for (const [name, available] of checks) if (!available) addError(`npm cannot provide ${name}@${pins.version}`)
} else {
  console.log('npm availability: SKIP (rerun with --network for the E02 gate)')
}

if (errors.length > 0) {
  console.error(`Runtime pin audit: FAIL\n${errors.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Runtime pin audit: PASS (${expected.size} DSH packages at ${pins.version}; ${installed.size} installed entries)`)
}
