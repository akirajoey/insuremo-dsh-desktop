import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { quoteWindowsArgument } from '../src/main/runtime/windows-supervisor-launcher'

const root = resolve(import.meta.dirname, '..')
const text = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('E08 Windows packaging contract', () => {
  it('pins NSIS x64, Windows icon, signing extensions, and the resource pipeline', () => {
    const packageJson = JSON.parse(text('package.json')) as { build: { asar: boolean; win: Record<string, unknown> }; scripts: Record<string, string> }
    expect(packageJson.build.asar).toBe(false)
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.win.icon).toBe('build/icon.ico')
    expect(packageJson.build.win.signExts).toEqual(['.exe', '.dll', '.node'])
    expect(packageJson.build.win.extraResources).toEqual([{ from: 'packaging/e08/runtime', to: 'dsh-runtime' }])
    expect(packageJson.scripts['package:e08:win']).toContain('electron-builder --win nsis --x64')
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
