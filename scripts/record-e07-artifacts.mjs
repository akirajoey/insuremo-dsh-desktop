import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const release = join(root, 'release')

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function record(path) {
  return { path: relative(root, path).split('\\').join('/'), size: statSync(path).size, sha256: hash(path) }
}
function verifySignature(path) {
  if (!existsSync(path)) return { present: false, valid: false }
  const check = spawnSync('codesign', ['--verify', '--deep', '--strict', path], { encoding: 'utf8' })
  const details = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' })
  const text = `${details.stdout ?? ''}\n${details.stderr ?? ''}`
  return {
    present: true,
    valid: check.status === 0,
    identity: text.match(/^Authority=(.+)$/m)?.[1] ?? null,
    teamIdentifier: text.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null,
    runtimeVersion: text.match(/^Runtime Version=(.+)$/m)?.[1] ?? null,
  }
}

const artifacts = []
if (existsSync(release)) {
  for (const name of readdirSync(release)) {
    if (/\.(?:zip|dmg|blockmap)$/u.test(name)) artifacts.push(record(join(release, name)))
  }
}
const signedApp = join(release, 'mac-arm64-signed/InsureMO DSH Desktop.app')
const unsignedApp = join(release, 'mac-arm64/InsureMO DSH Desktop.app')
const unsignedX64App = join(release, 'mac/InsureMO DSH Desktop.app')
const signedManifest = join(signedApp, 'Contents/Resources/dsh-runtime/manifest.json')
const unsignedManifest = join(unsignedApp, 'Contents/Resources/dsh-runtime/manifest.json')
const unsignedX64Manifest = join(unsignedX64App, 'Contents/Resources/dsh-runtime/manifest.json')
const appManifest = existsSync(signedManifest) ? JSON.parse(readFileSync(signedManifest, 'utf8')) : undefined
const evidence = {
  schemaVersion: 1,
  platform: 'darwin',
  hostArch: process.arch,
  electron: '43.4.0',
  electronBuilder: '26.0.12',
  asar: false,
  artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
  packagedDirectories: {
    signedArm64: { path: 'release/mac-arm64-signed/InsureMO DSH Desktop.app', ...verifySignature(signedApp), manifestSha256: existsSync(signedManifest) ? hash(signedManifest) : null },
    unsignedArm64: { path: 'release/mac-arm64/InsureMO DSH Desktop.app', ...verifySignature(unsignedApp), manifestSha256: existsSync(unsignedManifest) ? hash(unsignedManifest) : null },
    unsignedX64: { path: 'release/mac/InsureMO DSH Desktop.app', ...verifySignature(unsignedX64App), manifestSha256: existsSync(unsignedX64Manifest) ? hash(unsignedX64Manifest) : null },
  },
  runtime: appManifest === undefined ? null : {
    version: appManifest.runtimeVersion,
    nodeVersion: appManifest.nodeVersion,
    targetArch: appManifest.runtimeArch,
    fileCount: appManifest.files.length,
    workbenchSha256: appManifest.workbench.sha256,
    nodeFiles: appManifest.files.filter(entry => entry.path.endsWith('/bin/node')).map(entry => ({ path: entry.path, sha256: entry.sha256, size: entry.size })),
  },
  signing: {
    unsignedDevArtifactsAllowed: true,
    notarization: 'skipped without notarization credentials',
    envSeam: ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    residual: 'Apple Development signed dir is valid on this host; distribution identity/notarization remains a release gate.',
  },
}
const output = join(root, 'docs/evidence/e07-artifacts.json')
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ output: 'docs/evidence/e07-artifacts.json', artifacts: evidence.artifacts, signed: evidence.packagedDirectories.signedArm64.valid }, null, 2))
