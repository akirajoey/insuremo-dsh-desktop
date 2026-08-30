import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileManager } from '../src/main/profile/profile-manager'
import { DiagnosticsService } from '../src/main/app/diagnostics'
import { appendHarnessLog } from '../src/main/app/logs'

describe('E06 diagnostics collection', () => {
  it('flags missing modules, unparsable lockfiles, and redacts home paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e06-'))
    try {
      const userData = join(tmp, 'userData')
      const dshHome = join(tmp, 'harness')
      const pm = new ProfileManager({ userData, dshHome, pnpmEntry: 'pnpm', nodePath: 'node' })
      const profileDir = join(dshHome, 'profiles/web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@icomposer/workbench': '0.1.0', '@icomposer/broken-plugin': '0.1.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@icomposer/workbench'] } },
      }))
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: {{{ not yaml ]]')
      mkdirSync(join(profileDir, 'node_modules', '@icomposer', 'workbench'), { recursive: true })
      appendHarnessLog(userData, 'normal', '[rc7] boot exploded near /Users/example/secret\n')

      const service = new DiagnosticsService(pm, userData)
      const payload = service.collect({ mode: 'normal', phase: 'failed', message: `boom at ${dshHome}/profiles/web`, stderrTail: '' })
      expect(payload.profile.exists).toBe(true)
      expect(payload.profile.missingModules).toContain('@icomposer/broken-plugin')
      expect(payload.profile.missingModules).not.toContain('@icomposer/workbench')
      expect(payload.profile.lockfileParses).toBe(false)
      expect(payload.profile.lockfileSha256).not.toBeNull()
      expect(payload.profile.bundles).toContain('@icomposer/workbench')
      expect(payload.message).not.toContain(dshHome)
      expect(payload.logTail).toContain('boot exploded')
      expect(payload.logTail).not.toContain('/Users/example')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
