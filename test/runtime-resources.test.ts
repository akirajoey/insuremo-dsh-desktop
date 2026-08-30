import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExternalRuntimeRoot, verifyRuntimeRoot, writeRuntimeSourceConfig } from '../src/main/app/runtime-resources'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function makeRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), 'insuremo-runtime-source-'))
  const files = ['pnpm/bin/pnpm.cjs', 'harness/wrapper.cjs', `node/darwin-${process.arch}/bin/node`, 'workbench/workbench.tgz']
  for (const path of files) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, path)
  }
  const entries = files.map(path => ({
    path,
    kind: 'file' as const,
    size: readFileSync(join(root, path)).byteLength,
    sha256: digest(path),
  }))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: '0.1.0-rc.7',
    nodeVersion: '24.9.0',
    runtimeArch: process.arch,
    nodeMode: 'bundled',
    distribution: 'full-runtime',
    files: entries,
    workbench: { path: 'workbench/workbench.tgz', sha256: digest('workbench/workbench.tgz') },
  }, null, 2) + '\n')
  return root
}

describe('external runtime source contract', () => {
  it('persists an absolute source and verifies its manifest digest', () => {
    const root = makeRuntime()
    const userData = join(mkdtempSync(join(tmpdir(), 'insuremo-runtime-user-')), 'userData')
    try {
      const config = writeRuntimeSourceConfig(userData, root)
      expect(config.root).toBeTypeOf('string')
      expect(config.manifestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(existsSync(join(userData, 'desktop-state/runtime-source.json'))).toBe(true)
      const selection = resolveExternalRuntimeRoot(userData, [], {})
      const layout = verifyRuntimeRoot(selection.root, 'external', 'thin', selection.manifestSha256)
      expect(layout.source).toBe('external')
      expect(layout.variant).toBe('thin')
      expect(layout.nodePath).toContain('node/darwin-')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects changed manifests, wrong architectures, and escaping symlinks', () => {
    const root = makeRuntime()
    try {
      const original = readFileSync(join(root, 'manifest.json'), 'utf8')
      writeFileSync(join(root, 'manifest.json'), `${original} `)
      expect(() => verifyRuntimeRoot(root, 'external', 'thin', digest(original))).toThrow('digest')
      writeFileSync(join(root, 'manifest.json'), original)
      const wrongArch = JSON.parse(original) as { runtimeArch: string }
      wrongArch.runtimeArch = process.arch === 'arm64' ? 'x64' : 'arm64'
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(wrongArch))
      expect(() => verifyRuntimeRoot(root, 'external')).toThrow('architecture')
      writeFileSync(join(root, 'manifest.json'), original)
      const outside = join(root, '..', 'runtime-source-outside')
      writeFileSync(outside, 'outside')
      symlinkSync(outside, join(root, 'escape'))
      const manifest = JSON.parse(original) as { files: unknown[] }
      manifest.files.push({ path: 'escape', kind: 'symlink', size: 0, sha256: digest(outside), target: outside })
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
      expect(() => verifyRuntimeRoot(root, 'external')).toThrow('escapes root')
      rmSync(outside, { force: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(join(root, '..', 'runtime-source-outside'), { force: true })
    }
  })

  it('rejects relative roots and malformed runtime source flags', () => {
    expect(() => verifyRuntimeRoot('relative/runtime', 'external')).toThrow('absolute')
    expect(() => resolveExternalRuntimeRoot('/tmp/runtime-user', ['--runtime-root'], {})).toThrow('argument is missing')
    expect(() => resolveExternalRuntimeRoot('/tmp/runtime-user', ['--runtime-root=one', '--runtime-root=two'], {})).toThrow('more than once')
  })
})
