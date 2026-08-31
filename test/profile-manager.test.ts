import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler'
import { ProfileManager } from '../src/main/profile/profile-manager'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e03-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeTgz(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function manager(workbenchTgz?: string): ProfileManager {
  const tgz = workbenchTgz ?? join(tmp, 'workbench.tgz')
  if (!existsSync(tgz)) writeTgz(tgz, 'workbench-bundle')
  return new ProfileManager({
    userData,
    dshHome,
    pnpmEntry: 'pnpm.cjs',
    nodePath: process.execPath,
    workbenchTgzPath: tgz,
    workbenchSha256: ProfileManager.sha256(tgz),
  })
}

describe('pnpm launcher', () => {
  it('rejects unsafe specs', () => {
    expect(() => PnpmLauncher.assertSafeSpec('')).toThrow()
    expect(() => PnpmLauncher.assertSafeSpec('a\0b')).toThrow()
    expect(() => PnpmLauncher.assertSafeSpec('-abc')).toThrow()
    expect(() => PnpmLauncher.assertSafeSpec('--config')).toThrow()
    expect(() => PnpmLauncher.assertSafeSpec('pkg@1.2.3')).not.toThrow()
  })

  it('rejects non-fixed verbs', async () => {
    await expect(PnpmLauncher.run({
      nodePath: process.execPath,
      pnpmEntry: 'pnpm.cjs',
      cwd: tmp,
    }, 'exec', ['ls'])).rejects.toThrow()
  })
})

describe('bundle reconciler', () => {
  it('adds bundle layers for dsh.bundle dependencies and removes stale ones', () => {
    const profile = join(tmp, 'reconcile')
    mkdirSync(join(profile, 'node_modules/@composer/workbench'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { '@composer/workbench': '0.1.0' },
      dsh: { profile: { bundles: [] } },
    }))
    writeFileSync(join(profile, 'node_modules/@composer/workbench/package.json'), JSON.stringify({
      name: '@composer/workbench', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    BundleReconciler.reconcile(profile)
    const manifest = BundleReconciler.readManifest(profile)
    expect(manifest.dsh?.profile?.bundles).toContain('@composer/workbench')
  })
})

describe('profile manager journal matrix', () => {
  it('activates staging over current and keeps prev', () => {
    const pm = manager()
    mkdirSync(join(dshHome, 'profiles/web'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles/web/package.json'), '{"name":"old"}')
    const staging = pm.materializeStagingProfile('op-1')
    writeFileSync(join(staging, 'package.json'), '{"name":"new"}')
    const current = pm.activateStagedProfile(staging, 'op-1')
    expect(readFileSync(join(current, 'package.json'), 'utf8')).toContain('"new"')
    expect(existsSync(join(dshHome, 'profiles/web.prev'))).toBe(true)
    const journal = pm.readJournal()
    expect(journal?.phase).toBe('committed')
  })

  it('recovers prev when crash happened before commit', () => {
    const pm = manager()
    mkdirSync(join(dshHome, 'profiles/web'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles/web/package.json'), '{"name":"old"}')
    const staging = pm.materializeStagingProfile('op-2')
    writeFileSync(join(staging, 'package.json'), '{"name":"new"}')
    // Simulate crash after intent_move_old but before activation: move current to prev.
    const current = join(dshHome, 'profiles/web')
    const prev = join(dshHome, 'profiles/web.prev')
    mkdirSync(join(dshHome, 'profiles'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles/web.prev/package.json'), '{"name":"old"}')
    // Simulate journal with old_moved phase.
    const journalPath = join(userData, 'desktop-state', 'profile-operation.json')
    mkdirSync(join(userData, 'desktop-state'), { recursive: true })
    writeFileSync(journalPath, JSON.stringify({
      operationId: 'op-2', phase: 'old_moved',
      oldProfileHash: 'old', targetSpecDigest: 'digest',
      candidateDir: staging, currentDir: current, prevDir: prev, updatedAt: Date.now(),
    }))
    // Simulate filesystem: candidate active, prev exists, current is the candidate.
    rmSync(current, { recursive: true, force: true })
    writeFileSync(join(staging, 'package.json'), '{"name":"new"}')
    // Recovery should restore prev.
    pm.recover()
    expect(readFileSync(join(current, 'package.json'), 'utf8')).toContain('"old"')
  })

  it('materializes safe home without touching the normal home', () => {
    const pm = manager()
    // Ensure the normal home is absent after earlier tests' cleanup.
    rmSync(join(dshHome, 'profiles'), { recursive: true, force: true })
    const safeHome = pm.materializeSafeHome()
    expect(existsSync(join(safeHome, 'profiles/web/package.json'))).toBe(true)
    expect(existsSync(join(dshHome, 'profiles/web'))).toBe(false)
  })
})
