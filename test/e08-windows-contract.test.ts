import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { quoteWindowsArgument } from '../src/main/runtime/windows-supervisor-launcher'
import { textMatchesDevPathNeedle } from '../scripts/scan-dev-path-needles.mjs'

const root = resolve(import.meta.dirname, '..')
const text = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('E08 Windows packaging contract', () => {
  it('pins NSIS x64, Windows icon, signing extensions, and the resource pipeline', () => {
    const packageJson = JSON.parse(text('package.json')) as { build: { asar: boolean; electronLanguages?: string[]; win: Record<string, unknown> }; scripts: Record<string, string> }
    expect(packageJson.build.asar).toBe(false)
    expect(packageJson.build.electronLanguages).toEqual(['en', 'zh_CN', 'zh_TW'])
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.win.icon).toBe('build/icon.ico')
    expect(packageJson.build.win.signExts).toEqual(['.exe', '.dll', '.node'])
    expect(packageJson.build.win.extraResources).toEqual([{ from: 'packaging/e08/runtime', to: 'dsh-runtime' }])
    expect(packageJson.scripts['package:e08:win']).toContain('electron-builder --config scripts/electron-builder-config.mjs --win nsis --x64')
    const shared = text('scripts/electron-builder-config.mjs')
    expect(shared).toContain("appId: 'com.insuremo.dsh.desktop'")
    expect(shared).toContain("target: [{ target: 'nsis', arch: ['x64'] }]")
    expect(shared).toContain("from: 'packaging/e08/runtime', to: 'dsh-runtime'")
    expect(packageJson.scripts['build:e08:supervisor']).toContain('build-runtime-supervisor.ps1')
    expect(packageJson.scripts['build:e08:resources']).toContain('prepare-e08-windows-resources.mjs')
  })

  it('uses the official win-x64 Node hash and no shell forwarding', () => {
    const prepare = text('scripts/prepare-e08-windows-resources.mjs')
    expect(prepare).toContain('win-${arch}.zip')
    expect(prepare).toContain('6873514c3e6a012917cc6f95ce48a6289253370d025f1b69db290d70feebfa6e')
    expect(prepare).toContain("'--os', 'win32'")
    expect(prepare).toContain("'--ignore-scripts'")
    expect(text('src/main/profile/pnpm-launcher.ts')).toContain('shell: false')
    expect(text('src/main/profile/pnpm-launcher.ts')).toContain('windowsHide: true')
  })

  it('resolves pnpm cross-platform without host prefixes', async () => {
    const resolver = text('scripts/resolve-pnpm-entry.mjs')
    expect(resolver).toContain("process.platform === 'win32' ? 'where.exe' : 'which'")
    expect(resolver).toContain('DSH_TEST_PNPM_ENTRY')
    expect(resolver).toContain('DSH_PNPM_ENTRY')
    expect(resolver).toContain('npm_execpath')
    expect(resolver).toContain("node_modules', 'pnpm', 'bin', 'pnpm.cjs'")
    expect(resolver).not.toContain('/opt/homebrew')
    const fixture = text('scripts/build-test-plugin-fixture.mjs')
    expect(fixture).not.toContain("from 'node:child_process'")
    expect(fixture).not.toContain('execFileSync')
    const measure = text('scripts/measure-e07-runtime-size.mjs')
    expect(measure).toContain("from './resolve-pnpm-entry.mjs'")
    expect(measure).not.toContain('/opt/homebrew')
  })

  it('allows only the complete standard Homebrew PATH fragments in artifact scans', () => {
    expect(textMatchesDevPathNeedle('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin', '/opt/homebrew')).toBe(false)
    expect(textMatchesDevPathNeedle('const p = ["/opt/homebrew/bin", "/opt/homebrew/sbin"]', '/opt/homebrew')).toBe(false)
    expect(textMatchesDevPathNeedle('/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('/opt/homebrew/bin-custom', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('/opt/homebrew/sbin-custom', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('/opt/homebrew/binary-tool', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('/opt/homebrew', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('/opt/homebrew/lib', '/opt/homebrew')).toBe(true)
    expect(textMatchesDevPathNeedle('recorded /Users/junjie.zhang/dsh path', '/Users/junjie.zhang')).toBe(true)
    expect(textMatchesDevPathNeedle('clean text', '/Users/junjie.zhang')).toBe(false)
  })

  it('uses CommandLineToArgvW-compatible quoting for Windows paths', () => {
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('C:\\Program Files\\DSH')).toBe('"C:\\Program Files\\DSH"')
    expect(quoteWindowsArgument('C:\\DSH\\')).toBe('"C:\\DSH\\\\"')
    expect(quoteWindowsArgument('C:\\')).toBe('"C:\\\\"')
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"')
  })
  it('ships the signed Job Object and current-user pipe source contract', () => {
    expect(existsSync(resolve(root, 'native/runtime-supervisor/runtime-supervisor.cpp'))).toBe(true)
    const native = text('native/runtime-supervisor/runtime-supervisor.cpp')
    for (const marker of [
      'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'CreateNamedPipeW', 'CreateProcessW',
      'OpenProcess', 'ConvertSidToStringSidW', 'TerminateJobObject', 'MoveFileExW', 'CREATE_NO_WINDOW',
      'accepted', 'exited', 'timeout', 'forced', 'CommandLineToArgvW',
    ]) expect(native).toContain(marker)
    expect(text('scripts/build-runtime-supervisor.ps1')).toContain('cmake --build')
    expect(text('scripts/build-runtime-supervisor.ps1')).toContain('Visual Studio 17 2022')
    expect(text('src/main/runtime/windows-supervisor-launcher.ts')).toContain('createConnection(pipeName)')
    expect(text('src/main/runtime/windows-supervisor-launcher.ts')).not.toContain('taskkill')
    expect(text('src/main/runtime/wrapper.cjs')).toContain('--windows-supervisor')
  })
})
