import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const text = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('E07 target size and packaged settings contracts', () => {
  it('uses Electron run-as-Node and prepares no standalone Darwin Node', () => {
    const prepare = text('scripts/prepare-e07-resources.mjs')
    expect(prepare).toContain("nodeMode: 'electron-run-as-node'")
    expect(prepare).not.toContain('prepareNode')
    const resources = text('src/main/app/runtime-resources.ts')
    expect(resources).toContain("nodeMode === 'electron-run-as-node' ? process.execPath")
  })

  it('prunes only non-English/non-Chinese macOS locales before signing', () => {
    const packageJson = JSON.parse(text('package.json')) as { build: { afterPack?: string } }
    expect(packageJson.build.afterPack).toBe('scripts/prune-e07-locales.mjs')
    const prune = text('scripts/prune-e07-locales.mjs')
    expect(prune).toContain('electronPlatformName !== \'darwin\'')
    expect(prune).toContain('KEEP_LOCALE')
    expect(prune).toContain('\.lproj')
  })

  it('defines Thin and Full artifacts without changing app identity', () => {
    const config = text('scripts/electron-builder-config.mjs')
    expect(config).toContain("variant !== 'full' && variant !== 'thin'")
    expect(config).toContain("extraResources: variant === 'full'")
    expect(config).toContain('InsureMO DSH Desktop-')
    expect(config).toContain("appId: 'com.insuremo.dsh.desktop'")
    const packageJson = JSON.parse(text('package.json')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['package:e07:thin:arm64:dir']).toContain('DSH_DESKTOP_VARIANT=thin')
    expect(packageJson.scripts['package:e07:full:arm64:dir']).toContain('DSH_DESKTOP_VARIANT=full')
  })

  it('keeps Settings smoke read-only and limited to IMO/version/Skills projections', () => {
    const smoke = text('scripts/run-e07-packaged-smoke.mjs')
    expect(smoke).toContain('/api/icomposer-workbench/insuremo/overview?fast=0')
    // TASK-139: the expected IMO version is measured from the host CLI, not
    // hardcoded and not relaxed with a range comparison.
    expect(smoke).toContain('measureImoCliVersion')
    expect(smoke).toContain('value.imo.current === expectedImoVersion')
    expect(smoke).not.toContain('0.2.20')
    expect(smoke).toContain('value.skills.installed > 0')
    expect(smoke).not.toContain('access_token')
    expect(smoke).not.toContain('auth.profile')
  })

  it('records the temporary anchor comparison without replacing the proven umbrella closure', () => {
    const evidencePath = resolve(root, 'docs/evidence/e07-runtime-size.json')
    expect(existsSync(evidencePath)).toBe(true)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      probes: { minimalAnchors: { packageCount: number; nodeModulesBytes: number; direct: string[] }; umbrella: { packageCount: number; nodeModulesBytes: number } }
    }
    expect(evidence.probes.minimalAnchors.direct).toEqual(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(evidence.probes.minimalAnchors.packageCount).toBeGreaterThan(0)
    expect(evidence.probes.umbrella.packageCount).toBeGreaterThan(evidence.probes.minimalAnchors.packageCount)
    expect(evidence.probes.umbrella.nodeModulesBytes).toBeGreaterThan(evidence.probes.minimalAnchors.nodeModulesBytes)
  })
})
