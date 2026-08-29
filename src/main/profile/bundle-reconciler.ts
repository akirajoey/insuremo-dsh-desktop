import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface DshBundleManifest {
  name: string
  version?: string
  description?: string
  dsh?: {
    bundle?: { patch?: string }
    client?: unknown
  }
}

/**
 * Reconcile `dsh.profile.bundles` against the installed dependencies in a
 * profile directory. A dependency that declares `dsh.bundle.patch` joins the
 * layer stack; a bundle entry whose package is no longer a dependency leaves
 * it. This mirrors the official CLI's reconcile behavior but runs through the
 * desktop's fixed pnpm launcher.
 */
export class BundleReconciler {
  static readManifest(profileDir: string): { name: string; private?: boolean; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } {
    const path = join(profileDir, 'package.json')
    if (!existsSync(path)) throw new Error(`bundle reconciler: missing manifest ${path}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  static writeManifest(profileDir: string, manifest: Record<string, unknown>): void {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }

  static readDependencyManifest(profileDir: string, packageName: string): DshBundleManifest | undefined {
    const candidates = [
      join(profileDir, 'node_modules', packageName, 'package.json'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf8')) as DshBundleManifest
      }
    }
    return undefined
  }

  static reconcile(profileDir: string, beforeDeps?: ReadonlySet<string>): void {
    const manifest = BundleReconciler.readManifest(profileDir)
    const before = beforeDeps ?? new Set(Object.keys(manifest.dependencies ?? {}))
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const plugins = [...(manifest.dsh?.profile?.bundles ?? [])]
    const dependencySet = new Set(dependencies)
    let changed = false
    for (const packageName of dependencies) {
      const installed = BundleReconciler.readDependencyManifest(profileDir, packageName)
      const isBundle = installed?.dsh?.bundle?.patch !== undefined
      if (isBundle && !plugins.includes(packageName)) {
        plugins.push(packageName)
        changed = true
      }
    }
    for (const packageName of [...plugins]) {
      const wasDependency = before.has(packageName) || dependencySet.has(packageName)
      const stillDependency = dependencySet.has(packageName)
      const installed = stillDependency ? BundleReconciler.readDependencyManifest(profileDir, packageName) : undefined
      const stillBundle = stillDependency && installed?.dsh?.bundle?.patch !== undefined
      // Remove only a bundle that was previously installed as a dependency
      // and is no longer a bundle dependency. Template bundles (base,
      // web-app) are not dependencies and are never touched.
      if (wasDependency && !stillBundle) {
        plugins.splice(plugins.indexOf(packageName), 1)
        changed = true
      }
    }
    if (!changed) return
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: plugins },
    }
    BundleReconciler.writeManifest(profileDir, manifest)
  }
}
