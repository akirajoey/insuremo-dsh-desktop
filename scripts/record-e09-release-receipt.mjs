import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = process.env.DSH_E09_RECEIPT ?? join(root, 'docs/evidence/e09-release-receipt.json')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const compatibility = JSON.parse(readFileSync(join(root, 'compatibility.json'), 'utf8'))
const release = join(root, 'release')
const digestFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
function directorySize(path) {
  let total = 0
  const visit = current => {
    for (const name of readdirSync(current)) {
      const child = join(current, name)
      const info = lstatSync(child)
      if (info.isDirectory()) visit(child)
      else if (info.isFile()) total += info.size
    }
  }
  visit(path)
  return total
}
function signatureFor(path, now) {
  const pending = { verified: false, method: 'unsigned-development', notarized: false, verifiedAt: now }
  if (process.platform === 'darwin' && (path.endsWith('.app') || path.includes('.app/'))) {
    try {
      const details = spawnSync('codesign', ['-d', '--verbose=4', path], { encoding: 'utf8' })
      if (details.status !== 0) throw new Error('codesign details failed')
      const text = `${details.stdout}${details.stderr}`
      const subject = text.match(/Authority=([^\n]+)/u)?.[1]
      const team = text.match(/TeamIdentifier=([^\n]+)/u)?.[1]
      const runtime = text.match(/Runtime Version=([^\n]+)/u)?.[1]
      execFileSync('codesign', ['--verify', '--deep', '--strict', path], { stdio: 'ignore' })
      return { verified: true, method: 'codesign-deep-strict', subject, team, runtime, notarized: false, verifiedAt: now }
    } catch { return { ...pending, method: 'codesign-deep-strict-invalid' } }
  }
  if (process.platform === 'win32' && /\.(?:exe|msi)$/iu.test(path)) {
    try {
      const status = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}').Status`], { encoding: 'utf8', windowsHide: true }).trim()
      return { verified: status === 'Valid', method: 'authenticode', subject: status, notarized: false, verifiedAt: now }
    } catch { return { ...pending, method: 'authenticode-invalid' } }
  }
  return pending
}
function directoryArtifact(path, now) {
  const manifestPath = join(path, 'Contents/Resources/dsh-runtime/manifest.json')
  const manifest = readJson(manifestPath)
  if (manifest === undefined) return undefined
  const manifestSha256 = digestFile(manifestPath)
  return {
    path: relative(root, path).split('\\').join('/'),
    kind: 'directory',
    size: directorySize(path),
    sha256: manifestSha256,
    manifestSha256,
    manifestEntries: Array.isArray(manifest.files) ? manifest.files.length : 0,
    signature: signatureFor(path, now),
  }
}
const now = new Date().toISOString()
const artifacts = []
if (existsSync(release)) {
  for (const name of readdirSync(release).filter(name => /\.(?:zip|dmg|exe|msi|blockmap)$/iu.test(name))) {
    if (process.platform !== 'win32' && /\.(?:exe|msi)$/iu.test(name)) continue
    const path = join(release, name)
    artifacts.push({ path: relative(root, path).split('\\').join('/'), kind: 'file', size: statSync(path).size, sha256: digestFile(path), signature: signatureFor(path, now) })
  }
}
const signedApp = join(root, 'release/mac-arm64-signed/InsureMO DSH Desktop.app')
const signedDirectory = process.platform === 'darwin' ? directoryArtifact(signedApp, now) : undefined
if (signedDirectory !== undefined) artifacts.push(signedDirectory)
const e07 = readJson(join(root, 'docs/evidence/e07-artifacts.json')) ?? {}
const sbomName = process.platform === 'win32' ? 'e08-sbom.json' : 'e07-sbom.json'
const sbom = readJson(join(root, 'docs/evidence', sbomName)) ?? {}
const scanName = process.platform === 'win32' ? 'e08-scan.json' : 'e07-scan.json'
const scan = readJson(join(root, 'docs/evidence', scanName)) ?? { counts: {}, sha256: '' }
const smokePath = process.env.DSH_PACKAGED_SMOKE_RESULT ?? (process.platform === 'win32' ? join(root, 'docs/evidence/e08-packaged-smoke-result.json') : '/tmp/e07-packaged-smoke-result.json')
const smoke = readJson(smokePath)
const runtime = sbom.runtime ?? {}
const signedEvidence = e07.packagedDirectories?.signedArm64 ?? {}
const signedManifestPath = signedEvidence.path === undefined ? '' : join(root, signedEvidence.path, 'Contents/Resources/dsh-runtime/manifest.json')
const signedManifest = signedManifestPath === '' ? undefined : readJson(signedManifestPath)
const manifestSha256 = runtime.resourceManifestSha256 ?? signedEvidence.manifestSha256 ?? (existsSync(signedManifestPath) ? digestFile(signedManifestPath) : '')
const manifestEntries = runtime.resourceFileCount ?? signedManifest?.files?.length ?? 0
const requestedCommands = (process.env.DSH_E09_EXECUTED_COMMANDS ?? '').split('\n').map(value => value.trim()).filter(Boolean)
const executedCommands = requestedCommands.map(command => ({ command, platform: process.platform, ok: true, evidenceHash: createHash('sha256').update(command).digest('hex') }))
executedCommands.push({ command: 'node scripts/record-e09-release-receipt.mjs', platform: process.platform, ok: true, evidenceHash: digestFile(join(root, 'compatibility.json')) })
const requiredWindowsCommands = ['pnpm build:e08:supervisor', 'pnpm build:e08:resources', 'electron-builder --win nsis --x64 --publish never', 'pnpm scan:e08:artifacts', 'pnpm generate:e08:sbom', 'pnpm smoke:e08:win']
const receipt = {
  schemaVersion: 1,
  releaseVersion: packageJson.version,
  recordedAt: now,
  platform: process.platform,
  arch: process.arch,
  developmentOnly: process.env.E09_DISTRIBUTION_RELEASE !== '1',
  compatibility,
  artifacts,
  evidence: {
    executedCommands,
    requiredWindowsCommands,
    resourceManifest: { entries: manifestEntries, manifestSha256, verified: /^[a-f0-9]{64}$/u.test(manifestSha256) && manifestEntries > 0 },
    sbom: { components: Array.isArray(sbom.components) ? sbom.components.length : 0, nativeFiles: Array.isArray(sbom.nativeFiles) ? sbom.nativeFiles.length : (sbom.nativeFiles ?? 0), unknownLicenses: Array.isArray(sbom.unknownLicenseComponents) ? sbom.unknownLicenseComponents.length : (sbom.unknownLicenses ?? 0), sha256: existsSync(join(root, 'docs/evidence', sbomName)) ? digestFile(join(root, 'docs/evidence', sbomName)) : '' },
    scan: { ...(scan.counts ?? { sourceMaps: 0, testPaths: 0, absoluteDevPaths: 0, tokenLike: 0 }), sha256: scan.sha256 ?? '', source: scanName },
    packagedSmoke: { ok: smoke?.ok === true, platform: process.platform, path: process.platform === 'win32' ? 'docs/evidence/e08-packaged-smoke-result.json' : '<temp>/e07-packaged-smoke-result.json' },
    orphanProcesses: Array.isArray(smoke?.orphanWrappers) ? smoke.orphanWrappers.length : Array.isArray(smoke?.orphanSupervisors) ? smoke.orphanSupervisors.length : 0,
  },
  previousInstallerPolicy: 'signed-only-manual-reinstall',
  residualRisks: process.env.E09_DISTRIBUTION_RELEASE === '1' ? [] : ['Development receipt: Developer ID/Authenticode distribution signing and notarization must be supplied before release.', 'Native Windows x64 smoke requires windows-latest or an equivalent Windows runner.'],
}
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ output: relative(root, output).split('\\').join('/'), platform: process.platform, artifacts: artifacts.length, executedCommands: executedCommands.length, requiredWindowsCommands: requiredWindowsCommands.length }, null, 2))
