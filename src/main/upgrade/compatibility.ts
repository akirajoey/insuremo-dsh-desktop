import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CompatibilityManifest } from './contracts.ts'

export const COMPATIBILITY_FILE = 'compatibility.json'
export const REQUIRED_DESKTOP_VERSION = '0.1.0'
export const REQUIRED_DSH_VERSION = '0.1.0-rc.7'
export const REQUIRED_WORKBENCH_SHA256 = '1e205bd8eac1b76f521bcd3430bec1e02c66f26268e1719b05856bbab2506be5'

export function readCompatibility(path: string): CompatibilityManifest {
  if (isAbsolute(path) && !path.endsWith(COMPATIBILITY_FILE)) throw new Error('compatibility path must name compatibility.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as CompatibilityManifest
  assertCompatibilityShape(manifest)
  return manifest
}

export function compatibilityPath(appPath: string): string {
  return join(appPath, COMPATIBILITY_FILE)
}

export function assertCompatibilityShape(manifest: CompatibilityManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error('unsupported compatibility schema')
  if (manifest.desktop?.version !== REQUIRED_DESKTOP_VERSION) throw new Error('desktop compatibility version mismatch')
  if (manifest.dsh?.version !== REQUIRED_DSH_VERSION) throw new Error('DSH compatibility version mismatch')
  if (manifest.dsh?.runtimeGraph !== 'rc7') throw new Error('DSH runtime graph compatibility mismatch')
  if (manifest.workbench?.sha256 !== REQUIRED_WORKBENCH_SHA256) throw new Error('Workbench compatibility hash mismatch')
  if (manifest.profile?.schemaVersion !== 1 || manifest.session?.schemaVersion !== 1) throw new Error('profile/session schema mismatch')
  if (manifest.profile.layout !== 'harness/profiles/web' || manifest.session.format !== 'jsonl') throw new Error('profile/session layout mismatch')
  if (!manifest.profile.requiredFiles.includes('package.json') || !manifest.profile.requiredFiles.includes('pnpm-lock.yaml')) throw new Error('profile compatibility files incomplete')
}

export function compatibilitySummary(manifest: CompatibilityManifest): Record<string, string | number> {
  return {
    desktop: manifest.desktop.version,
    dsh: manifest.dsh.version,
    workbench: manifest.workbench.version,
    workbenchSha256: manifest.workbench.sha256,
    profileSchema: manifest.profile.schemaVersion,
    sessionSchema: manifest.session.schemaVersion,
  }
}
