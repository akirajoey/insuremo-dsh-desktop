import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_WORKBENCH_SHA256 } from '../src/main/upgrade/compatibility'
import { WORKBENCH_SHA256, WORKBENCH_TGZ } from './support/workbench'

const root = resolve(import.meta.dirname, '..')
const accepted = REQUIRED_WORKBENCH_SHA256
const acceptedCommit = '8119f0c'
// Assembled at runtime so this file never matches its own stale-identity scan.
const supersededSha = ['1e205bd8', 'eac1b76f521bcd3430bec1e02c66f26268e1719b05856bbab2506be5'].join('')
const supersededCommit = ['737db', 'cb'].join('')

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourceFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
  return tracked.filter((path) => /\.(ts|tsx|mjs|json|md)$/u.test(path) && path !== 'pnpm-lock.yaml')
}

describe('TASK-138 Workbench identity (risk: critical - wrong bytes ship)', () => {
  it('keeps every identity copy on the accepted published artifact', () => {
    const compatibility = JSON.parse(text('compatibility.json')) as {
      workbench?: { version?: string; sha256?: string }
    }
    expect(compatibility.workbench?.version).toBe('0.1.0')
    expect(compatibility.workbench?.sha256).toBe(accepted)
    expect(WORKBENCH_SHA256).toBe(accepted)
    expect(text('test/support/workbench.ts')).toContain(`WORKBENCH_SHA256 = '${accepted}'`)
    expect(text('scripts/run-e07-diagnosis-smoke.mjs')).toContain(accepted)
  })

  it('hashes the frozen accepted tarball to the pin and names the published commit', () => {
    const artifact = process.env.DSH_WORKBENCH_TGZ ?? WORKBENCH_TGZ
    if (!existsSync(artifact)) return
    expect(digest(artifact)).toBe(accepted)
    // The tarball itself carries the package identity, not a branch name.
    const packedPackage = JSON.parse(
      execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
    ) as { name?: string; version?: string; scripts?: Record<string, string> }
    expect(packedPackage.name).toBe('@icomposer/workbench')
    expect(packedPackage.version).toBe('0.1.0')
    // Release payloads must not carry install-time lifecycle scripts.
    expect(packedPackage.scripts?.postinstall).toBeUndefined()
    const guide = text('docs/workbench-sync.md')
    expect(guide).toContain(acceptedCommit)
    expect(guide).toContain(accepted)
  })
})

describe('TASK-138 packaging contract (risk: high - fail-open staging or src drift)', () => {
  it('refuses an absent Workbench artifact instead of packaging a stale runtime', () => {
    const prepare = text('scripts/prepare-e07-resources.mjs')
    expect(prepare).toContain('DSH_WORKBENCH_TGZ must point to the verified Workbench tgz')
    expect(prepare).toContain('copied Workbench SHA256 mismatch')
    expect(prepare).toContain("sha256(bundledWorkbench) !== workbenchSha256")
    // Real fail-closed proof: a missing artifact aborts before any runtime write.
    let failed = false
    try {
      execFileSync(process.execPath, ['scripts/prepare-e07-resources.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DSH_WORKBENCH_TGZ: '/nonexistent/workbench.tgz' },
      })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  it('writes the accepted hash and the stock rc.7 runtime identity into the runtime manifest', () => {
    const prepare = text('scripts/prepare-e07-resources.mjs')
    expect(prepare).toContain("runtimeVersion: '0.1.0-rc.7'")
    expect(prepare).toContain("nodeMode: 'electron-run-as-node'")
    expect(prepare).toContain("workbench: { path: 'workbench/icomposer-workbench.tgz', sha256: workbenchSha256 }")
    const pins = JSON.parse(text('config/runtime-pins.json')) as { version?: string; source?: string; packagePattern?: string }
    expect(pins.version).toBe('0.1.0-rc.7')
    expect(pins.source).toBe('npm')
    expect(pins.packagePattern).toBe('^@deepseek-ai/dsh(?:-|$)')
    expect(text('src/main/upgrade/compatibility.ts')).toContain("REQUIRED_DSH_VERSION = '0.1.0-rc.7'")
  })
})

describe('TASK-138 build-source hygiene (risk: high - local patches or user data)', () => {
  it('never points the Desktop build at a local Harness checkout, vendor dir, or user profile', () => {
    const scanned = [
      'package.json',
      'scripts/prepare-e07-resources.mjs',
      'test/support/workbench.ts',
      'src/main/upgrade/compatibility.ts',
    ]
    for (const path of scanned) {
      const body = text(path)
      for (const forbidden of ['deepseek-harness', 'vendor/', '/Users/', '~/.dsh', 'node_modules/.pnpm/../../deepseek']) {
        expect(`${path}: ${body.includes(forbidden) ? forbidden : 'clean'}`).toBe(`${path}: clean`)
      }
    }
    const smoke = text('scripts/run-e07-diagnosis-smoke.mjs')
    expect(smoke).toContain('DSH_DESKTOP_TEST_USER_DATA')
    expect(smoke).not.toContain("'/Applications/InsureMO DSH Desktop.app'")
    const guide = text('docs/workbench-sync.md')
    expect(guide).toContain('080–082')
    expect(guide).toContain('24.18.1')
    expect(guide).toContain('Do not point a build at a user')
  })

  it('leaves no superseded Workbench identity behind in tracked sources', () => {
    const supersededShaFiles = sourceFiles().filter((path) => text(path).includes(supersededSha))
    expect(supersededShaFiles).toEqual([])
    // The guide may name the older baseline once, and only as the branch `main`
    // still carries; it must never present it as the accepted sync source.
    const guide = text('docs/workbench-sync.md')
    expect(guide.match(new RegExp(supersededCommit, 'gu'))?.length).toBe(1)
    expect(guide).toMatch(new RegExp('`main`\\s+branch still points at the earlier accepted baseline `' + supersededCommit + '`', 'u'))
    const supersededCommitFiles = sourceFiles()
      .filter((path) => !path.endsWith('.md'))
      .filter((path) => text(path).includes(supersededCommit))
    expect(supersededCommitFiles).toEqual([])
  })
})

describe('TASK-138 deliverable hygiene (risk: medium/low)', () => {
  it('keeps generated packaging output out of git', () => {
    const ignore = text('.gitignore')
    for (const entry of ['release/', 'packaging/e07/runtime/', 'packaging/e07/cache/']) {
      expect(ignore.split('\n')).toContain(entry)
    }
    const scripts = JSON.parse(text('package.json')).scripts as Record<string, string>
    expect(scripts['package:e07:full:arm64:dir']).toContain('--config.directories.output=release/mac-arm64-Full')
    expect(scripts['package:e07:full:arm64:dir']).toContain('DSH_DESKTOP_VARIANT=full')
    expect(scripts['package:e07:full:arm64:dir']).toContain('DSH_RUNTIME_ARCH=arm64')
  })

  it('preserves the existing icon generation and single-window activation behaviour', () => {
    const activation = text('src/main/app/window-activation.ts')
    expect(activation).toContain('export function resolveActivation')
    expect(activation).toContain("if (state.desktopWindowCount > 0) return 'raise'")
    expect(text('src/main/index.ts')).toContain("from './app/window-activation.ts'")
    expect(existsSync(join(root, 'test/window-activation.test.ts'))).toBe(true)
    const scripts = JSON.parse(text('package.json')).scripts as Record<string, string>
    expect(scripts.build).toContain('node scripts/gen-icon.mjs')
    expect(text('scripts/electron-builder-config.mjs')).toContain("'build/icon.png'")
  })
})
