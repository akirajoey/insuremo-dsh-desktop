import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, ...rest] = process.argv[i].split('=')
  if (key.startsWith('--')) args.set(key.slice(2), rest.join('='))
}
const path = args.get('path') ?? process.env.DSH_PREVIOUS_INSTALLER
const expected = (args.get('sha256') ?? process.env.DSH_PREVIOUS_INSTALLER_SHA256 ?? '').toLowerCase()
const platform = args.get('platform') ?? process.platform
const version = args.get('version') ?? process.env.DSH_PREVIOUS_INSTALLER_VERSION ?? ''
if (path === undefined || path === '') throw new Error('usage: --path=<previous-signed-installer> --sha256=<sha256> --version=<version>')
if (!existsSync(path)) throw new Error(`previous installer missing: ${path}`)
function hashPath(value) {
  const info = lstatSync(value)
  if (info.isDirectory()) {
    const digest = createHash('sha256')
    for (const name of readdirSync(value).sort()) digest.update(name).update(hashPath(`${value}/${name}`))
    return digest.digest('hex')
  }
  if (info.isSymbolicLink()) return createHash('sha256').update(`link:${readlinkSync(value)}`).digest('hex')
  return createHash('sha256').update(readFileSync(value)).digest('hex')
}
const actual = hashPath(path)
if (!/^[a-f0-9]{64}$/u.test(expected) || actual !== expected) throw new Error(`previous installer SHA256 mismatch: ${actual}`)
let signature = { verified: false, method: platform === 'win32' ? 'authenticode' : 'codesign-deep-strict' }
if (platform === 'win32') {
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}').Status`], { encoding: 'utf8', windowsHide: true }).trim()
  signature = { verified: output === 'Valid', method: 'authenticode', subject: output }
} else if (path.endsWith('.app') || path.includes('.app/')) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', path], { stdio: 'ignore' })
  signature = { verified: true, method: 'codesign-deep-strict' }
} else {
  throw new Error('previous installer must be an app bundle on macOS or an Authenticode file on Windows')
}
const receipt = { schemaVersion: 1, platform, version, path: basename(path), sha256: actual, signature, recordedAt: new Date().toISOString() }
console.log(JSON.stringify(receipt, null, 2))
if (!signature.verified || version === '') process.exitCode = 1
