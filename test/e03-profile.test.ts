import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler'
import { ProfileManager } from '../src/main/profile/profile-manager'

const TGZ = '/Users/junjie.zhang/dsh/icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz'
const SHA = 'b1019017b79782a97b0b980268c2250384446ae5bbed8cb62af41c0754bdc59f'
const PNPM = '/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs'
const NODE = '/opt/homebrew/bin/node'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e03-'))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('E03 profile manager', () => {
  it('installs workbench into a staging profile and activates it with bundles intact', async () => {
    const userData = join(tmp, 'userData')
    const dshHome = join(tmp, 'harness')
    const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: TGZ, workbenchSha256: SHA })
    const cached = pm.ensureWorkbenchArtifact()
    const staging = pm.materializeStagingProfile('test')
    const result = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 120_000 }, 'add', ['--save-exact', `file:${cached}`])
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(staging, 'node_modules/@icomposer/workbench/package.json'))).toBe(true)
    BundleReconciler.reconcile(staging)
    const manifest = BundleReconciler.readManifest(staging)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@icomposer/workbench'])
    pm.activateStagedProfile(staging, 'test')
    const activated = BundleReconciler.readManifest(join(dshHome, 'profiles/web'))
    expect(activated.dsh?.profile?.bundles).toContain('@icomposer/workbench')
    expect(pm.readJournal()?.phase).toBe('committed')
  })

  it('recovers previous generation on crash before commit', async () => {
    const userData = join(tmp, 'userData-r')
    const dshHome = join(tmp, 'harness-r')
    const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: TGZ, workbenchSha256: SHA })
    const staging = pm.materializeStagingProfile('rec')
    const current = join(dshHome, 'profiles/web')
    const prev = join(dshHome, 'profiles/web.prev')
    // Simulate crash: current moved to prev, candidate not committed.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dshHome, 'profiles'), { recursive: true })
    mkdirSync(prev, { recursive: true })
    writeFileSync(join(prev, 'package.json'), '{"name":"old"}')
    writeFileSync(join(staging, 'package.json'), '{"name":"new"}')
    mkdirSync(join(userData, 'desktop-state'), { recursive: true })
    writeFileSync(join(userData, 'desktop-state', 'profile-operation.json'), JSON.stringify({
      operationId: 'rec', phase: 'old_moved', oldProfileHash: 'old', targetSpecDigest: 'd',
      candidateDir: staging, currentDir: current, prevDir: prev, updatedAt: Date.now(),
    }))
    pm.recover()
    expect(existsSync(join(current, 'package.json'))).toBe(true)
  })
})
