import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { ProfileManager } from '../src/main/profile/profile-manager'
import { DEFAULT_SAFE_RUNTIME_PINS, safeGraphDescriptor, safeGraphStale, safeRuntimeOverrides, renderSafeWorkspaceYaml } from '../src/main/profile/safe-runtime-graph'

const root = resolve(import.meta.dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-task139-'))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

const pins = JSON.parse(text('config/runtime-pins.json')) as {
  version: string
  packagePattern: string
  nonDshCordisPattern: string
  packages: string[]
  nonDshCordis?: Record<string, string>
}

function lockCordisPins(): Record<string, string> {
  const lock = parse(text('pnpm-lock.yaml')) as { packages?: Record<string, unknown> }
  const dshPattern = new RegExp(pins.packagePattern)
  const cordisPattern = new RegExp(pins.nonDshCordisPattern)
  const found: Record<string, string> = {}
  for (const key of Object.keys(lock.packages ?? {})) {
    const match = key.match(/^(?<name>@[^/]+\/[^@]+|[^@]+)@(?<version>\d+\.\d+\.\d+(?:-[^()]+)?)(?:\(|$)/u)
    if (match?.groups === undefined) continue
    const { name, version } = match.groups
    if (dshPattern.test(name) || !cordisPattern.test(name)) continue
    if (found[name] !== undefined && found[name] !== version) throw new Error(`lockfile carries several ${name} versions`)
    found[name] = version
  }
  return found
}

describe('TASK-139 frozen safe-home graph (risk: critical - release-blocking safe boot)', () => {
  it('records exactly the non-DSH Cordis versions the frozen lockfile resolves', () => {
    const frozen = lockCordisPins()
    expect(Object.keys(frozen).length).toBeGreaterThan(0)
    expect(pins.nonDshCordis).toEqual(frozen)
    for (const version of Object.values(frozen)) expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  })

  it('emits an override for every DSH packument and every frozen Cordis package', () => {
    const overrides = safeRuntimeOverrides({ version: pins.version, packages: pins.packages, nonDshCordis: pins.nonDshCordis })
    expect(overrides['@deepseek-ai/dsh-base']).toBe('0.1.0-rc.7')
    expect(overrides['@deepseek-ai/dsh-web-app']).toBe('0.1.0-rc.7')
    for (const [name, version] of Object.entries(lockCordisPins())) expect(overrides[name]).toBe(version)
    // The versions that broke the safe boot must never be produced by fallback.
    expect(overrides['@deepseek-ai/cordis-plugin-hmr']).not.toBe('1.0.19')
    expect(() => safeRuntimeOverrides({ version: '0.1.0-rc.7', packages: [], nonDshCordis: { '@deepseek-ai/cordis-plugin-hmr': '^1.0.16' } })).toThrow(/not exact/u)
  })

  it('renders a safe workspace whose overrides match the pins and keep the isolated install shape', () => {
    const rendered = parse(renderSafeWorkspaceYaml({ version: pins.version, packages: pins.packages, nonDshCordis: pins.nonDshCordis })) as {
      nodeLinker?: string
      autoInstallPeers?: boolean
      overrides?: Record<string, string>
    }
    expect(rendered.nodeLinker).toBe('hoisted')
    expect(rendered.autoInstallPeers).toBe(false)
    expect(rendered.overrides).toEqual(safeRuntimeOverrides({ version: pins.version, packages: pins.packages, nonDshCordis: pins.nonDshCordis }))
    expect(rendered.overrides?.['@deepseek-ai/cordis-plugin-hmr']).toBe(lockCordisPins()['@deepseek-ai/cordis-plugin-hmr'])
  })

  it('materializes the safe home with the frozen overrides and leaves the normal home untouched', () => {
    const userData = join(tmp, 'userData')
    const dshHome = join(tmp, 'harness')
    const pm = new ProfileManager({ userData, dshHome, pnpmEntry: 'pnpm.cjs', nodePath: process.execPath })
    const safeHome = pm.materializeSafeHome({ version: pins.version, packages: pins.packages, nonDshCordis: pins.nonDshCordis })
    const workspace = parse(readFileSync(join(safeHome, 'profiles/web/pnpm-workspace.yaml'), 'utf8')) as { overrides?: Record<string, string> }
    for (const [name, version] of Object.entries(lockCordisPins())) expect(workspace.overrides?.[name]).toBe(version)
    expect(existsSync(join(dshHome, 'profiles/web'))).toBe(false)
  })
})

describe('TASK-139 safe-home repair and provenance (risk: high - silent stale graph)', () => {
  it('treats a missing or older graph fingerprint as stale so the install is re-run', () => {
    const expected = safeGraphDescriptor({ version: pins.version, packages: pins.packages, nonDshCordis: pins.nonDshCordis })
    expect(safeGraphStale(undefined, expected)).toBe(true)
    expect(safeGraphStale(null, expected)).toBe(true)
    expect(safeGraphStale('not-a-graph', expected)).toBe(true)
    expect(safeGraphStale({ ...expected, version: '0.1.0-rc.6' }, expected)).toBe(true)
    // The pre-TASK-139 floating graph (hmr 1.0.19) must be re-installed.
    expect(safeGraphStale({ ...expected, overrides: { ...expected.overrides, '@deepseek-ai/cordis-plugin-hmr': '1.0.19' } }, expected)).toBe(true)
    expect(safeGraphStale({ ...expected, overrides: { ...expected.overrides, '@deepseek-ai/extra': '1.0.0' } }, expected)).toBe(true)
    expect(safeGraphStale({ ...expected, schemaVersion: 0 }, expected)).toBe(true)
    expect(safeGraphStale(expected, expected)).toBe(false)
    expect(safeGraphStale(DEFAULT_SAFE_RUNTIME_PINS, expected)).toBe(true)
  })

  it('wires the pins through the app and the packaged resource build', () => {
    const manager = text('src/main/app/harness-manager.ts')
    expect(manager).toContain('readRuntimeCordisPins(appRoot())')
    expect(manager).toContain('nonDshCordis')
    expect(manager).toContain('safeGraphStale(readJson(graphPath), expectedGraph)')
    expect(manager).toContain('writeFileSync(graphPath, JSON.stringify(expectedGraph, null, 2)')
    const profile = text('src/main/profile/profile-manager.ts')
    expect(profile).toContain('renderSafeWorkspaceYaml(runtimePins)')
    const prepare = text('scripts/prepare-e07-resources.mjs')
    expect(prepare).toContain('verifyFrozenCordisPins(runtimeRoot)')
    expect(prepare).toContain('config/runtime-pins.json records')
    expect(prepare).toContain('frozenCordisPackages')
    const audit = text('scripts/audit-runtime-pins.mjs')
    expect(audit).toContain('frozen non-DSH Cordis pins')
    expect(audit).toContain('runtime pins are missing the frozen nonDshCordis map')
  })

  it('keeps the packaged smoke honest about the IMO CLI version', () => {
    const smoke = text('scripts/run-e07-packaged-smoke.mjs')
    expect(smoke).toContain('function measureImoCliVersion()')
    expect(smoke).toContain("spawnSync('imo', ['--version']")
    expect(smoke).toContain('value.imo.current === expectedImoVersion')
    expect(smoke).not.toContain("0.2.20")
    expect(smoke).not.toMatch(/imo\.current\s*>=/u)
    expect(text('test/e07-size.test.ts')).toContain("expect(smoke).not.toContain('0.2.20')")
  })

  it('records a development-only release set with the excluded files named', () => {
    const evidence = JSON.parse(text('docs/evidence/e07-full-release.json')) as {
      distribution: string
      artifacts: { path: string; size: number; sha256: string }[]
      excluded: { path: string; reason: string }[]
      packagedApp: { signature: { valid: boolean; signature: string | null; teamIdentifier: string | null } }
      chain: { bundledWorkbenchSha256: string; compatibilityWorkbenchSha256: string; runtimeManifestWorkbenchSha256: string }
      expandedApp: { matches: boolean }
    }
    expect(evidence.distribution).toBe('development-only')
    expect(evidence.artifacts.map(artifact => artifact.path.split('/').at(-1))).toEqual([
      'InsureMO DSH Desktop-Full-0.1.0-arm64.dmg',
      'InsureMO DSH Desktop-Full-0.1.0-arm64.zip',
    ])
    for (const artifact of evidence.artifacts) {
      expect(artifact.size).toBeGreaterThan(0)
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(evidence.chain.bundledWorkbenchSha256).toBe(evidence.chain.compatibilityWorkbenchSha256)
    expect(evidence.chain.bundledWorkbenchSha256).toBe(evidence.chain.runtimeManifestWorkbenchSha256)
    expect(evidence.expandedApp.matches).toBe(true)
    expect(evidence.packagedApp.signature.valid).toBe(false)
    expect(evidence.packagedApp.signature.signature).toBe('adhoc')
    expect(evidence.packagedApp.signature.teamIdentifier).toBe('not set')
    expect(evidence.excluded.length).toBeGreaterThan(0)
    expect(evidence.excluded.every(item => !/Desktop-Full-0\.1\.0-arm64\.(?:dmg|zip)$/u.test(item.path))).toBe(true)
    const readme = text('README.md')
    expect(readme).toContain('SHA256SUMS.txt')
    expect(readme).toContain('unsigned (adhoc)')
    expect(readme).toContain('Gatekeeper')
    expect(readme).toContain('development-only')
    expect(text('docs/release-evidence-checklist.md')).toContain('TASK-139 macOS arm64 Full package (development-only)')
  })
})
