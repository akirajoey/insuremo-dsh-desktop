import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_WORKBENCH_SHA256 } from '../src/main/upgrade/compatibility'

const root = resolve(import.meta.dirname, '..')
const expected = '1e205bd8eac1b76f521bcd3430bec1e02c66f26268e1719b05856bbab2506be5'
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('TASK-087 Workbench synchronization contract', () => {
  it('keeps the artifact hash identical across compatibility and test mappings', () => {
    const compatibility = JSON.parse(text('compatibility.json')) as { workbench?: { version?: string; sha256?: string } }
    expect(expected).toBe(REQUIRED_WORKBENCH_SHA256)
    expect(compatibility.workbench?.version).toBe('0.1.0')
    expect(compatibility.workbench?.sha256).toBe(expected)
    expect(text('test/support/workbench.ts')).toContain(`WORKBENCH_SHA256 = '${expected}'`)
  })

  it('matches the accepted sibling tarball when one is available', () => {
    const configured = process.env.DSH_WORKBENCH_TGZ
    const sibling = resolve(root, '../icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz')
    const artifact = configured ?? sibling
    if (existsSync(artifact)) expect(digest(artifact)).toBe(expected)
  })

  it('documents source build order, stock rc.7 runtime, and isolated diagnosis smoke', () => {
    const guide = text('docs/workbench-sync.md')
    expect(guide).toContain('737dbcb')
    expect(guide).toContain('0.1.0-rc.7')
    expect(guide).toContain('pnpm bundle')
    expect(guide).toContain('pnpm pack:git-dist')
    expect(guide).toContain('pnpm check:git-dist')
    expect(guide).toContain('pnpm pack:dist')
    expect(guide).toContain('pnpm smoke:e07:diagnosis')
    expect(guide).toContain('080–082')
    expect(guide).toContain('24.18.1')
    expect(guide).toContain('24.9.0')
    expect(guide).toContain('ditto')
  })

  it('keeps the packaged diagnosis fixture isolated and non-destructive', () => {
    const smoke = text('scripts/run-e07-diagnosis-smoke.mjs')
    expect(smoke).toContain('DSH_DESKTOP_TEST_USER_DATA')
    expect(smoke).toContain('fakebin')
    expect(smoke).toContain('exit 1')
    expect(smoke).toContain("npm_config_registry: 'http://127.0.0.1:9/'")
    expect(smoke).toContain("join(fakeBin, 'npm')")
    expect(smoke).toContain('no model request')
    expect(smoke).not.toContain("'/Applications/InsureMO DSH Desktop.app'")
  })
})
