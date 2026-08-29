import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCompatibility } from '../src/main/upgrade/compatibility'
import { createUpgradeSnapshot, restoreUpgradeSnapshot, verifyUpgradeSnapshot } from '../src/main/upgrade/upgrade-snapshot'
import { RollbackManager } from '../src/main/upgrade/rollback-manager'
import { ProfileManager } from '../src/main/profile/profile-manager'

const root = resolve(import.meta.dirname, '..')
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('E09 compatibility and upgrade snapshots', () => {
  it('requires exact desktop/DSH/Workbench/profile/session compatibility', () => {
    const compatibility = readCompatibility(join(root, 'compatibility.json'))
    expect(compatibility.desktop.version).toBe('0.1.0')
    expect(compatibility.dsh.version).toBe('0.1.0-rc.7')
    expect(compatibility.workbench.sha256).toHaveLength(64)
    expect(compatibility.profile.schemaVersion).toBe(1)
    expect(compatibility.session.schemaVersion).toBe(1)
  })

  it('snapshots profile/session/settings without copying token stores', () => {
    const userData = mkdtempSync(join(tmpdir(), 'e09-snapshot-'))
    temporary.push(userData)
    mkdirSync(join(userData, 'harness/profiles/web'), { recursive: true })
    mkdirSync(join(userData, 'harness/sessions'), { recursive: true })
    mkdirSync(join(userData, 'harness/token-store'), { recursive: true })
    writeFileSync(join(userData, 'harness/profiles/web/package.json'), '{"name":"profile"}\n')
    writeFileSync(join(userData, 'harness/sessions/one.jsonl'), '{"session":1}\n')
    writeFileSync(join(userData, 'harness/settings.yaml'), 'theme: dark\n')
    writeFileSync(join(userData, 'harness/token-store/token.json'), '{"access_token":"never-copy"}\n')
    writeFileSync(join(userData, 'harness/auth.json'), '{"refresh_token":"never-copy"}\n')
    const compatibility = readCompatibility(join(root, 'compatibility.json'))
    const snapshot = createUpgradeSnapshot({ userData, compatibility, snapshotId: 'before-upgrade' })
    const snapshotPath = join(userData, 'desktop-state/upgrades/before-upgrade/snapshot')
    expect(verifyUpgradeSnapshot(snapshotPath).sha256).toBe(snapshot.sha256)
    expect(snapshot.files.some(file => file.path.includes('token'))).toBe(false)
    expect(existsSync(join(snapshotPath, 'harness/token-store/token.json'))).toBe(false)
    expect(existsSync(join(snapshotPath, 'harness/auth.json'))).toBe(false)
    writeFileSync(join(userData, 'harness/profiles/web/package.json'), '{"name":"changed"}\n')
    writeFileSync(join(userData, 'harness/token-store/token.json'), '{"access_token":"keep"}\n')
    restoreUpgradeSnapshot(snapshotPath, userData)
    expect(readFileSync(join(userData, 'harness/profiles/web/package.json'), 'utf8')).toContain('profile')
    expect(readFileSync(join(userData, 'harness/token-store/token.json'), 'utf8')).toContain('keep')
  })

  it('separates executed platform evidence from required Windows plan', () => {
    const receiptScript = readFileSync(join(root, 'scripts/record-e09-release-receipt.mjs'), 'utf8')
    expect(receiptScript).toContain('executedCommands')
    expect(receiptScript).toContain('requiredWindowsCommands')
    expect(receiptScript).toContain("platform: process.platform")
    const receiptPath = join(root, 'docs/evidence/e09-release-receipt.json')
    if (existsSync(receiptPath)) {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { platform: string; artifacts: Array<{ kind: string; sha256: string; signature: { verifiedAt: string } }>; evidence: { executedCommands: Array<{ platform: string; command: string }>; requiredWindowsCommands: string[] } }
      expect(receipt.evidence.requiredWindowsCommands.length).toBeGreaterThanOrEqual(5)
      expect(receipt.evidence.executedCommands.every(entry => entry.platform === receipt.platform)).toBe(true)
      expect(receipt.artifacts.every(artifact => artifact.sha256.length === 64 && artifact.signature.verifiedAt !== '')).toBe(true)
      expect(receipt.artifacts.filter(artifact => artifact.kind === 'directory').every(artifact => artifact.sha256.length === 64)).toBe(true)
      if (receipt.platform === 'darwin') expect(receipt.evidence.executedCommands.some(entry => entry.command.includes('e08') || entry.command.includes('--win'))).toBe(false)
    }
  })
  it('keeps desktop rollback manual and distinct from plugin rollback', () => {
    const userData = mkdtempSync(join(tmpdir(), 'e09-rollback-'))
    temporary.push(userData)
    const artifact = join(userData, 'previous.exe')
    writeFileSync(artifact, 'signed-installer')
    const manager = new ProfileManager({ userData, dshHome: join(userData, 'harness'), nodePath: process.execPath, pnpmEntry: process.execPath })
    const rollback = new RollbackManager({ userData, profileManager: manager })
    const result = rollback.rollbackDesktop({ schemaVersion: 1, platform: 'win32', version: '0.0.9', path: artifact, sha256: createHash('sha256').update('signed-installer').digest('hex'), signature: { verified: true, method: 'authenticode' }, recordedAt: new Date().toISOString() })
    expect(result.ok).toBe(true)
    expect(result.requiresUserAction).toBe(true)
    expect(result.message).toContain('manually')
  })
})
