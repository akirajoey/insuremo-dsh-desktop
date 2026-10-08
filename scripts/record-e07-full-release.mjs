/**
 * Record the macOS arm64 Full release artifacts (TASK-139).
 *
 * Scope is explicit: only the DMG/ZIP produced by
 * `package:e07:full:arm64:mac` in the given output directory are release
 * artifacts. Auto-update metadata, blockmaps, and any older Thin/Full package
 * that happens to sit in `release/` are recorded as **excluded** so nobody
 * uploads a stale package by filename.
 *
 * The chain verified here is: source Workbench tgz (frozen pins) →
 * `packaging/e07/runtime/manifest.json` → bundled tgz inside the packaged app →
 * app compatibility mapping. The app inside the DMG/ZIP is verified separately
 * (see docs/evidence/e07-full-release.json `expandedApp`).
 *
 * Usage:
 *   node scripts/record-e07-full-release.mjs [--dir release/mac-arm64-Full] \
 *     [--packaged-smoke <json>] [--diagnosis-smoke <json>] [--build-log <path>]
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const argValue = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const outputDir = resolve(root, argValue('--dir') ?? 'release/mac-arm64-Full')
const releaseDir = join(root, 'release')
const evidencePath = join(root, 'docs/evidence/e07-full-release.json')
const sumsPath = join(outputDir, 'SHA256SUMS.txt')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const arch = 'arm64'

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const rel = path => relative(root, path).split('\\').join('/')
const record = path => ({ path: rel(path), size: statSync(path).size, sha256: digest(path) })
const readJson = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined)

/** Release artifacts are only the variant/arch artifacts of this build. */
const artifactNames = [`InsureMO DSH Desktop-Full-${version}-${arch}.dmg`, `InsureMO DSH Desktop-Full-${version}-${arch}.zip`]
const artifacts = artifactNames.map(name => record(join(outputDir, name)))
for (const artifact of artifacts) {
  if (!existsSync(join(root, artifact.path))) throw new Error(`release artifact missing: ${artifact.path}`)
}

/** Everything else in the build directory is metadata or a blockmap. */
const companions = readdirSync(outputDir)
  .filter(name => !artifactNames.includes(name) && /\.(?:blockmap|yml|dmg|zip|json)$/u.test(name))
  .map(name => record(join(outputDir, name)))

/** Older packages elsewhere in release/ must never be uploaded for this build. */
const excluded = []
if (existsSync(releaseDir)) {
  for (const name of readdirSync(releaseDir)) {
    const path = join(releaseDir, name)
    if (!statSync(path).isFile()) continue
    if (!/\.(?:dmg|zip|blockmap|yml)$/u.test(name)) continue
    excluded.push({ ...record(path), reason: 'not produced by this build (older Full/Thin package or metadata)' })
  }
}

const appPath = join(outputDir, 'mac-arm64', 'InsureMO DSH Desktop.app')
const runtimeManifestPath = join(appPath, 'Contents/Resources/dsh-runtime/manifest.json')
const bundledTgzPath = join(appPath, 'Contents/Resources/dsh-runtime/workbench/icomposer-workbench.tgz')
const packagedCompatibilityPath = join(appPath, 'Contents/Resources/app/compatibility.json')
const binaryPath = join(appPath, 'Contents/MacOS/InsureMO DSH Desktop')
const manifest = readJson(runtimeManifestPath)
const compatibility = readJson(packagedCompatibilityPath)
const sourceTgz = join(root, '../icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz')

if (manifest === undefined || compatibility === undefined) throw new Error('packaged app resources are incomplete')
const bundledSha = digest(bundledTgzPath)
if (bundledSha !== manifest.workbench.sha256) throw new Error(`bundled Workbench tgz ${bundledSha} != runtime manifest ${manifest.workbench.sha256}`)
if (compatibility.workbench.sha256 !== bundledSha) throw new Error(`compatibility pin ${compatibility.workbench.sha256} != bundled Workbench ${bundledSha}`)
const sourceRecord = existsSync(sourceTgz) ? record(sourceTgz) : undefined
if (sourceRecord !== undefined && sourceRecord.sha256 !== bundledSha) {
  throw new Error(`source Workbench tgz ${sourceRecord.sha256} != bundled ${bundledSha}`)
}
if (manifest.runtimeVersion !== '0.1.0-rc.7' || manifest.nodeMode !== 'electron-run-as-node' || manifest.runtimeArch !== arch) {
  throw new Error(`unexpected packaged runtime identity: ${JSON.stringify({ version: manifest.runtimeVersion, nodeMode: manifest.nodeMode, arch: manifest.runtimeArch })}`)
}

const signature = (() => {
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' })
  const details = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' })
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`
  return {
    verifyExit: verify.status,
    valid: verify.status === 0,
    signature: output.match(/^Signature=(.+)$/m)?.[1] ?? null,
    identifier: output.match(/^Identifier=(.+)$/m)?.[1] ?? null,
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null,
    authority: /^Authority=(.+)$/m.exec(output)?.[1] ?? null,
    notarized: false,
    distribution: 'development-only: unsigned (adhoc) build, gatekeeper will block a plain download until the user explicitly allows it',
  }
})()
const sums = artifacts.map(artifact => `${artifact.sha256}  ${basename(artifact.path)}`).join('\n') + '\n'
writeFileSync(sumsPath, sums)

/**
 * Expand the DMG and ZIP and prove they carry the same app bytes recorded from
 * the build directory: runtime manifest, bundled Workbench tgz, packaged
 * compatibility mapping, and the main binary.
 */
function identifyApp(appDir) {
  const files = {
    runtimeManifest: join(appDir, 'Contents/Resources/dsh-runtime/manifest.json'),
    bundledWorkbenchTgz: join(appDir, 'Contents/Resources/dsh-runtime/workbench/icomposer-workbench.tgz'),
    packagedCompatibility: join(appDir, 'Contents/Resources/app/compatibility.json'),
    binary: join(appDir, 'Contents/MacOS/InsureMO DSH Desktop'),
  }
  return Object.fromEntries(Object.entries(files).map(([key, path]) => {
    if (!existsSync(path)) throw new Error(`expanded app is missing ${key}: ${path}`)
    return [key, { sha256: digest(path), size: statSync(path).size }]
  }))
}

function verifyExpandedApp() {
  if (process.platform !== 'darwin') return { skipped: true, reason: 'DMG expansion requires darwin' }
  const temp = mkdtempSync(join(tmpdir(), 'e07-full-release-'))
  const mountPoint = join(temp, 'dmg')
  const zipDir = join(temp, 'zip')
  mkdirSync(mountPoint, { recursive: true })
  mkdirSync(zipDir, { recursive: true })
  let attached = false
  try {
    const dmgPath = join(outputDir, artifactNames[0])
    const zipPath = join(outputDir, artifactNames[1])
    const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath], { encoding: 'utf8' })
    if (attach.status !== 0) throw new Error(`hdiutil attach failed: ${attach.stderr ?? attach.error?.message}`)
    attached = true
    execFileSync('ditto', ['-x', '-k', zipPath, zipDir])
    const dmg = identifyApp(join(mountPoint, 'InsureMO DSH Desktop.app'))
    const zip = identifyApp(join(zipDir, 'InsureMO DSH Desktop.app'))
    const buildDir = identifyApp(appPath)
    const matches = JSON.stringify(dmg) === JSON.stringify(buildDir) && JSON.stringify(zip) === JSON.stringify(buildDir)
    if (!matches) throw new Error('DMG/ZIP app identity differs from the built app directory')
    return { dmg, zip, buildDir, matches }
  } finally {
    if (attached) spawnSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8' })
    rmSync(temp, { recursive: true, force: true })
  }
}

const smokeSummary = path => {
  const result = readJson(path)
  if (result === undefined) return undefined
  return {
    source: resolve(root, path),
    ok: result.ok === true,
    ...(result.normal === undefined ? {} : { normalExit: result.normal.exit?.code, settings: result.normal.settings, plugin: result.normal.plugin }),
    ...(result.safe === undefined ? {} : { safeExit: result.safe.exit?.code }),
    ...(result.safeRepair === undefined ? {} : { safeRepair: { exit: result.safeRepair.exit?.code, frozenHmr: result.safeRepair.frozenHmr } }),
    ...(result.fakeNpxRuns === undefined ? {} : { fakeNpxRuns: result.fakeNpxRuns }),
    ...(result.imoCli === undefined ? {} : { imoCli: result.imoCli }),
    homeDshUnchanged: result.homeDshUnchanged,
    orphanWrappers: result.orphanWrappers,
    killedLingeringInstalls: result.killedLingeringInstalls,
    errors: result.errors,
  }
}
const buildLog = argValue('--build-log')
const expandedApp = verifyExpandedApp()
const evidence = {
  schemaVersion: 1,
  task: 'TASK-139',
  platform: 'darwin',
  arch,
  version,
  distribution: 'development-only',
  artifacts,
  sha256sums: record(sumsPath),
  companions,
  excluded,
  packagedApp: {
    path: rel(appPath),
    binary: record(binaryPath),
    runtimeManifest: record(runtimeManifestPath),
    bundledWorkbenchTgz: record(bundledTgzPath),
    packagedCompatibility: record(packagedCompatibilityPath),
    runtime: { version: manifest.runtimeVersion, nodeVersion: manifest.nodeVersion, arch: manifest.runtimeArch, nodeMode: manifest.nodeMode },
    signature,
  },
  chain: {
    sourceWorkbenchTgz: sourceRecord,
    bundledWorkbenchSha256: bundledSha,
    compatibilityWorkbenchSha256: compatibility.workbench.sha256,
    runtimeManifestWorkbenchSha256: manifest.workbench.sha256,
  },
  expandedApp,
  smokes: {
    packaged: smokeSummary(argValue('--packaged-smoke') ?? '/tmp/e07-packaged-smoke-result.json'),
    diagnosis: smokeSummary(argValue('--diagnosis-smoke') ?? '/tmp/task139/diagnosis.json'),
  },
  buildLog: buildLog === undefined ? undefined : { path: rel(resolve(root, buildLog)), sha256: digest(resolve(root, buildLog)) },
  commands: [
    `DSH_WORKBENCH_TGZ=<icomposer-workbench>/dist-release/icomposer-workbench-0.1.0.tgz pnpm package:e07:full:arm64:mac`,
    `node scripts/run-e07-packaged-smoke.mjs "${'<app binary>'}"`,
    `node scripts/scan-e07-artifacts.mjs release/mac-arm64-Full`,
  ],
  residuals: [
    'The DMG/ZIP are unsigned (adhoc) and not notarized; a downloaded copy is blocked by Gatekeeper until the user allows it.',
    'macOS x64 and Windows artifacts are not built or verified by this task.',
    'Only the DMG and ZIP are release artifacts: blockmaps, latest-mac.yml, and older Thin/Full packages are excluded.',
  ],
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({
  evidence: rel(evidencePath),
  sha256sums: rel(sumsPath),
  artifacts: artifacts.map(artifact => ({ path: artifact.path, size: artifact.size, sha256: artifact.sha256 })),
  excluded: excluded.map(item => item.path),
  signing: signature.valid === true ? 'valid' : signature.signature,
  expandedAppMatches: expandedApp.matches ?? null,
}, null, 2))
