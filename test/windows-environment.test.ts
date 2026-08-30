import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { captureLoginShellEnvironment, mergeExecutablePaths, resolveExecutableFromEnvironment } from '../src/main/app/windows-environment.ts'

describe('Finder/runtime environment capture', () => {
  it('resolves IMO from a minimal explicit PATH without invoking a shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-env-'))
    const imo = join(root, 'imo')
    try {
      writeFileSync(imo, '#!/bin/sh\nexit 0\n')
      chmodSync(imo, 0o755)
      expect(resolveExecutableFromEnvironment('imo', { PATH: `/usr/bin:${root}` })).toBe(imo)
      const installed = '/opt/homebrew/bin/imo'
      if (existsSync(installed)) expect(resolveExecutableFromEnvironment('imo', { PATH: '/usr/bin:/bin:/opt/homebrew/bin' })).toBe(installed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('imports only login-shell PATH, has standard fallbacks, and keeps secrets out of shell import', () => {
    const originalPath = process.env.PATH
    const originalSecret = process.env.DSH_TEST_LOGIN_SECRET
    const base = { PATH: '/usr/bin', DSH_TEST_LOGIN_SECRET: 'inherited-only' }
    const captured = captureLoginShellEnvironment(base, () => Buffer.from('PATH=/custom/bin:/opt/homebrew/bin\0SECRET_TOKEN=do-not-import\0'))
    expect(captured.PATH).toBe(mergeExecutablePaths('/usr/bin', '/custom/bin:/opt/homebrew/bin', '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin'))
    expect(captured.SECRET_TOKEN).toBeUndefined()
    expect(captured.DSH_TEST_LOGIN_SECRET).toBe('inherited-only')
    expect(process.env.PATH).toBe(originalPath)
    expect(process.env.DSH_TEST_LOGIN_SECRET).toBe(originalSecret)
  })
})
