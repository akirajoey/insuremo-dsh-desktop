import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const path = process.env.DSH_E09_RECEIPT ?? join(root, 'docs/evidence/e09-release-receipt.json')
const receipt = JSON.parse(readFileSync(path, 'utf8'))
const fail = message => { throw new Error(`release receipt: ${message}`) }
const digestFile = value => createHash('sha256').update(readFileSync(value)).digest('hex')
const directorySize = value => {
  let total = 0
  const visit = current => { for (const name of readdirSync(current)) { const child = join(current, name); const info = lstatSync(child); if (info.isDirectory()) visit(child); else if (info.isFile()) total += info.size } }
  visit(value)
  return total
}
const expectedCompatibility = JSON.parse(readFileSync(join(root, 'compatibility.json'), 'utf8'))
const e07 = JSON.parse(readFileSync(join(root, 'docs/evidence/e07-artifacts.json'), 'utf8'))
if (receipt.schemaVersion !== 1) fail('unsupported schema')
if (!/^\d+\.\d+\.\d+$/u.test(receipt.releaseVersion)) fail('invalid release version')
if (receipt.previousInstallerPolicy !== 'signed-only-manual-reinstall') fail('unsafe previous installer policy')
if (JSON.stringify(receipt.compatibility) !== JSON.stringify(expectedCompatibility)) fail('compatibility manifest drift')
if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) fail('no artifacts recorded')
for (const artifact of receipt.artifacts) {
  if (artifact.path.includes('..') || artifact.path.startsWith('/') || /^[A-Za-z]:/u.test(artifact.path)) fail('artifact path is not relative')
  if (!['file', 'directory'].includes(artifact.kind) || !Number.isInteger(artifact.size) || artifact.size <= 0) fail(`invalid artifact digest metadata: ${artifact.path}`)
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) fail(`empty/invalid artifact digest: ${artifact.path}`)
  const artifactPath = resolve(root, artifact.path)
  if (!existsSync(artifactPath)) fail(`artifact missing: ${artifact.path}`)
  const actualSize = artifact.kind === 'directory' ? directorySize(artifactPath) : statSync(artifactPath).size
  if (actualSize !== artifact.size) fail(`artifact size mismatch: ${artifact.path}`)
  if (artifact.kind === 'file' && digestFile(artifactPath) !== artifact.sha256) fail(`artifact hash mismatch: ${artifact.path}`)
  if (artifact.kind === 'directory') {
    const manifestPath = join(artifactPath, 'Contents/Resources/dsh-runtime/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!/^[a-f0-9]{64}$/u.test(artifact.manifestSha256) || artifact.sha256 !== artifact.manifestSha256 || digestFile(manifestPath) !== artifact.manifestSha256) fail(`directory manifest digest mismatch: ${artifact.path}`)
    if (manifest.files.length !== artifact.manifestEntries || artifact.manifestEntries <= 0) fail(`directory manifest entry count mismatch: ${artifact.path}`)
    const signed = e07.packagedDirectories?.signedArm64
    if (receipt.platform === 'darwin' && signed?.path === artifact.path) {
      if (signed.manifestSha256 !== artifact.manifestSha256 || signed.valid !== artifact.signature.verified || signed.identity !== artifact.signature.subject || signed.teamIdentifier !== artifact.signature.team) fail(`receipt differs from E07 signed directory evidence: ${artifact.path}`)
      if (signed.runtimeVersion !== artifact.signature.runtime) fail(`signed runtime evidence mismatch: ${artifact.path}`)
    }
  }
  const signature = artifact.signature
  if (typeof signature?.verified !== 'boolean' || typeof signature?.method !== 'string' || typeof signature?.notarized !== 'boolean' || typeof signature?.verifiedAt !== 'string' || signature.verifiedAt === '') fail(`incomplete signature evidence: ${artifact.path}`)
}
const executed = receipt.evidence?.executedCommands
if (!Array.isArray(executed)) fail('executedCommands is required')
for (const entry of executed) {
  if (entry.platform !== receipt.platform || entry.ok !== true || typeof entry.command !== 'string' || typeof entry.evidenceHash !== 'string') fail('executed command is not platform-matched evidence')
  if (!/^[a-f0-9]{64}$/u.test(entry.evidenceHash)) fail('executed command evidence hash is invalid')
}
const windowsPlan = receipt.evidence?.requiredWindowsCommands
if (!Array.isArray(windowsPlan) || windowsPlan.length < 5) fail('required Windows command plan is incomplete')
if (receipt.platform !== 'win32' && executed.some(entry => entry.command.includes('e08') || entry.command.includes('--win'))) fail('Windows commands were claimed on a non-Windows receipt')
if (receipt.platform === 'win32' && !windowsPlan.every(command => executed.some(entry => entry.command === command))) fail('Windows receipt lacks native executed command evidence')
if (receipt.platform === 'win32' && !receipt.artifacts.some(artifact => artifact.path.match(/\.(?:exe|msi)$/iu))) fail('Windows receipt lacks a native installer artifact')
if (receipt.platform === 'win32' && receipt.evidence?.scan?.source !== 'e08-scan.json') fail('Windows receipt lacks native e08 scan evidence')
if (receipt.platform === 'win32' && receipt.evidence?.packagedSmoke?.path !== 'docs/evidence/e08-packaged-smoke-result.json') fail('Windows receipt lacks native e08 smoke evidence')
const scan = receipt.evidence?.scan
if (scan === undefined || scan.sourceMaps !== 0 || scan.testPaths !== 0 || scan.absoluteDevPaths !== 0 || scan.tokenLike !== 0 || !/^[a-f0-9]{64}$/u.test(scan.sha256)) fail('artifact scan is not clean')
const sbom = receipt.evidence?.sbom
if (sbom === undefined || sbom.components <= 0 || sbom.nativeFiles < 1 || sbom.unknownLicenses !== 0 || !/^[a-f0-9]{64}$/u.test(sbom.sha256)) fail('SBOM evidence is incomplete')
const resource = receipt.evidence?.resourceManifest
if (resource === undefined || resource.verified !== true || resource.entries <= 0 || !/^[a-f0-9]{64}$/u.test(resource.manifestSha256)) fail('resource manifest was not verified')
const smoke = receipt.evidence?.packagedSmoke
if (smoke?.ok !== true || smoke.platform !== receipt.platform) fail('packaged smoke is not platform-matched and green')
if (receipt.evidence.orphanProcesses !== 0) fail('orphan process evidence is not clean')
if (!receipt.developmentOnly && receipt.artifacts.some(artifact => !artifact.signature.verified || artifact.signature.notarized === false || artifact.signature.method.includes('unsigned'))) fail('distribution receipt contains unsigned/unnotarized artifacts')
if (JSON.stringify(receipt).match(/(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9]{20,})/u)) fail('token-like material present')
console.log(JSON.stringify({ ok: true, releaseVersion: receipt.releaseVersion, platform: receipt.platform, artifacts: receipt.artifacts.length, executedCommands: executed.length, developmentOnly: receipt.developmentOnly, scan, sbom }, null, 2))
