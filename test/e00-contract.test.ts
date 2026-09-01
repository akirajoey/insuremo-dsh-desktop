import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

it('records the accepted local-access decision without machine-specific data', async () => {
  const adr = await readFile(resolve(root, 'docs/decisions/ADR-0001-local-access-boundary.md'), 'utf8')
  expect(adr).toContain('same-user local trust')
  expect(adr).toContain('127.0.0.1')
  expect(adr).toContain('Strong-auth alternative')
  expect(adr).not.toMatch(/\/Users\/|[A-Z]:\\/)
})

it('isolates Chromium helper userData when the packaged test seam is enabled', async () => {
  const source = await readFile(resolve(root, 'src/main/index.ts'), 'utf8')
  expect(source).toContain("app.commandLine.appendSwitch('user-data-dir', testOverride)")
  expect(source).toContain("app.setPath('userData', testOverride)")
})

describe('exact runtime pins', () => {
  it('keeps direct dependencies exact', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      packageManager: string
    }
    expect(packageJson.packageManager).toBe('pnpm@11.7.0')
    for (const section of [packageJson.dependencies, packageJson.devDependencies]) {
      for (const version of Object.values(section)) expect(version).not.toMatch(/^[~^]/)
    }
    expect(packageJson.devDependencies.electron).toBe('43.4.0')
    expect(packageJson.dependencies.react).toBe('18.3.1')
  })
})
