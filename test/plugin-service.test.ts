import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ProfileManager } from '../src/main/profile/profile-manager'
import { PnpmLauncher } from '../src/main/profile/pnpm-launcher'
import { BundleReconciler } from '../src/main/profile/bundle-reconciler'
import { PluginService, sanitizeErrorMessage } from '../src/main/plugins/plugin-service'

const TGZ = '/tmp/e04-test-plugin.tgz'
const WORKBENCH_TGZ = '/Users/junjie.zhang/dsh/icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz'
const WB_SHA = 'b1019017b79782a97b0b980268c2250384446ae5bbed8cb62af41c0754bdc59f'
const PNPM = '/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs'
const NODE = '/opt/homebrew/bin/node'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e04-'))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function setup(): { pm: ProfileManager; svc: PluginService; dshHome: string } {
  const userData = join(tmp, 'userData')
  const dshHome = join(tmp, 'harness')
  const pm = new ProfileManager({ userData, dshHome, pnpmEntry: PNPM, nodePath: NODE, workbenchTgzPath: WORKBENCH_TGZ, workbenchSha256: WB_SHA })
  const svc = new PluginService({ profileManager: pm, capabilityDir: join(tmp, 'capabilities'), pnpmEntry: PNPM, nodePath: NODE, workbenchName: '@icomposer/workbench' })
  return { pm, svc, dshHome }
}

describe('E04 plugin service', () => {
  it('installs a tgz test bundle via capability, records provenance, and removes it', async () => {
    const { pm, svc } = setup()
    // Seed the profile with workbench (as in E03) so the web profile exists.
    const cached = pm.ensureWorkbenchArtifact()
    const staging = pm.materializeStagingProfile('seed')
    const seed = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 120_000 }, 'add', ['--save-exact', `file:${cached}`])
    expect(seed.exitCode).toBe(0)
    BundleReconciler.reconcile(staging)
    pm.activateStagedProfile(staging, 'seed')

    // Install the test plugin via a one-time capability.
    svc.registerCapability('cap-1', TGZ)
    const result = await svc.runOperation('add', 'tgz:cap-1', 'tgz:cap-1')
    expect(result.ok).toBe(true)
    expect(result.provenance?.tgzSha256).toBe('3255f0e8496aaac7fdbd11f37df1f034a0ca851cc80bf468284b935e347ba883')
    expect(result.provenance?.lockfileIntegrity).not.toBe('')

    // The bundle must be in the manifest layer.
    const manifest = BundleReconciler.readManifest(join(pm.dshHome, 'profiles/web'))
    expect(manifest.dsh?.profile?.bundles).toContain('@icomposer/test-plugin')

    // List shows the plugin.
    const entries = svc.listPlugins()
    expect(entries.some(e => e.name === '@icomposer/test-plugin')).toBe(true)

    // Remove it through the service.
    const remove = await svc.runOperation('remove', '@icomposer/test-plugin')
    expect(remove.ok).toBe(true)
    const manifestAfter = BundleReconciler.readManifest(join(pm.dshHome, 'profiles/web'))
    expect(manifestAfter.dsh?.profile?.bundles).not.toContain('@icomposer/test-plugin')
  }, 300_000)

  it('rolls back to the previous verified generation', async () => {
    const { pm, svc } = setup()
    const cached = pm.ensureWorkbenchArtifact()
    const staging = pm.materializeStagingProfile('seed-rb')
    const seed = await PnpmLauncher.run({ nodePath: NODE, pnpmEntry: PNPM, cwd: staging, timeoutMs: 120_000 }, 'add', ['--save-exact', `file:${cached}`])
    expect(seed.exitCode).toBe(0)
    BundleReconciler.reconcile(staging)
    pm.activateStagedProfile(staging, 'seed-rb')

    svc.registerCapability('cap-rb', TGZ)
    const result = await svc.runOperation('add', 'tgz:cap-rb', 'tgz:cap-rb')
    expect(result.ok).toBe(true)
    const rb = await svc.rollback()
    expect(rb.ok).toBe(true)
    // Rollback must leave a committed journal (covers its own destructive window).
    const rbJournal = pm.readJournal()
    expect(rbJournal?.phase).toBe('committed')
    const manifest = BundleReconciler.readManifest(join(pm.dshHome, 'profiles/web'))
    expect(manifest.dsh?.profile?.bundles).not.toContain('@icomposer/test-plugin')
    expect(manifest.dsh?.profile?.bundles).toContain('@icomposer/workbench')
  }, 300_000)

  it('consumes capabilities exactly once and redacts absolute paths from errors', async () => {
    const { svc } = setup()
    svc.registerCapability('cap-once', TGZ)
    expect(svc.consumeCapability('cap-once')).toBe(TGZ)
    expect(() => svc.consumeCapability('cap-once')).toThrow(/already-consumed/)

    const sanitized = sanitizeErrorMessage(
      `staged pnpm failed: ENOENT at ${svc['pm'].dshHome}/profiles/web and /tmp/insuremo-dsh-e04-xyz/cache.tgz`,
      [svc['pm'].userData, svc['pm'].dshHome, '/Users/junjie.zhang'],
    )
    expect(sanitized).not.toContain('/Users/junjie.zhang')
    expect(sanitized).not.toContain('/tmp/insuremo-dsh-e04-xyz')
    expect(sanitized).toContain('<redacted>')
    expect(sanitized).toContain('<path>')
  })
})
