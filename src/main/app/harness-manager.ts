import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeController } from '../runtime/controller.ts'
import type { RuntimeSnapshot } from '../runtime/contracts.ts'
import { PnpmLauncher } from '../profile/pnpm-launcher.ts'
import { BundleReconciler } from '../profile/bundle-reconciler.ts'
import { ProfileManager } from '../profile/profile-manager.ts'
import { appendHarnessLog, harnessLogPath } from './logs.ts'
import { appRoot } from './app-root.ts'
import { captureDesktopEnvironment } from './windows-environment.ts'

/** Resolve the wrapper from source in dev or the hashed Vite asset in out/. */
export function resolveWrapperPath(runtimeRoot?: string): string {
  if (app.isPackaged) {
    const bundled = join(runtimeRoot ?? process.resourcesPath, runtimeRoot === undefined ? 'dsh-runtime/harness/wrapper.cjs' : 'harness/wrapper.cjs')
    if (existsSync(bundled)) return bundled
    throw new Error('packaged runtime wrapper is missing')
  }
  const root = appRoot()
  const source = join(root, 'src/main/runtime/wrapper.cjs')
  if (existsSync(source)) return source
  const outDir = join(root, 'out/main')
  const asset = readdirSync(outDir).find(name => /^wrapper(?:-[A-Za-z0-9_-]+)?\.cjs$/u.test(name))
  if (asset !== undefined) return join(outDir, asset)
  throw new Error('runtime wrapper asset missing')
}

export type HarnessMode = 'normal' | 'safe'

export interface HarnessManagerOptions {
  userData: string
  profileManager: ProfileManager
  /** Exact @deepseek-ai/dsh* runtime version used for the safe home install. */
  runtimePin: string
  pnpmEntry: string
  nodePath: string
  /** Shell environment captured once for runtime and package operations. */
  environment?: Record<string, string>
  shutdownGraceMs?: number
  forkMode?: 'fork' | 'utility'
  execPath?: string
  /** Signed Windows helper that owns the bundled Node Job Object. */
  supervisorPath?: string
  /** Verified runtime root; points outside the app for Thin builds. */
  runtimeRoot?: string
  /** Explicit opt-in for the packaged Electron run-as-Node experiment. */
  runAsNode?: boolean
}

/**
 * Owns the harness runtime lifecycle for the desktop shell: normal boot,
 * safe-mode boot (independent safe DSH home), restart, and shutdown with a
 * forced-kill fallback so quitting never leaves a resident harness.
 */
export class HarnessManager {
  mode: HarnessMode = 'normal'
  private controller: RuntimeController | undefined
  private safeHome: string | undefined
  private readonly options: HarnessManagerOptions

  constructor(options: HarnessManagerOptions) {
    this.options = options
  }

  get running(): boolean {
    return this.controller !== undefined && this.controller.phase !== 'idle' && this.controller.phase !== 'failed'
  }

  snapshot(): RuntimeSnapshot {
    return this.controller?.snapshot() ?? { phase: 'idle', message: 'not started' }
  }

  homeFor(mode: HarnessMode): string {
    if (mode === 'safe') return this.safeHome ?? join(this.options.userData, 'safe-runtime/harness')
    return this.options.profileManager.dshHome
  }

  /** Stop the current runtime (graceful, then forced) and forget it. */
  async stop(graceMs = this.options.shutdownGraceMs ?? 5_000): Promise<void> {
    const controller = this.controller
    if (controller === undefined) return
    this.controller = undefined
    const outcome = await controller.requestShutdown(graceMs)
    appendHarnessLog(this.options.userData, this.mode, `[desktop] shutdown outcome=${outcome.kind}\n`)
  }

  /**
   * Restart the harness: stop whatever is running, then boot the requested
   * (or current) mode. Returns the final snapshot.
   */
  async restart(mode: HarnessMode = this.mode): Promise<RuntimeSnapshot> {
    await this.stop()
    return this.start(mode)
  }

  /**
   * Boot the harness in the requested mode. Safe mode materializes an
   * independent safe DSH home (base+web-app only) and never touches the
   * normal home; the Plugin Manager keeps targeting the normal home.
   */
  async start(mode: HarnessMode = 'normal'): Promise<RuntimeSnapshot> {
    await this.stop()
    const environment = this.options.environment ?? captureDesktopEnvironment()
    this.mode = mode
    if (mode === 'normal') await this.ensureBundledWorkbench(environment)
    const dshHome = mode === 'safe' ? await this.prepareSafeHome(environment) : this.options.profileManager.dshHome
    const controller = new RuntimeController({
      launchId: `desktop-${mode}-${Date.now()}`,
      dshHome,
      wrapperPath: resolveWrapperPath(this.options.runtimeRoot),
      cwd: this.options.profileManager.runtimeAnchor ?? process.cwd(),
      env: {
        ...environment,
        DSH_HOME: dshHome,
        NO_COLOR: '1',
        DSH_DESKTOP_LOG: harnessLogPath(this.options.userData, mode),
      },
      userData: this.options.userData,
      forkMode: this.options.forkMode ?? 'utility',
      execPath: this.options.execPath,
      supervisorPath: this.options.supervisorPath,
      runAsNode: this.options.runAsNode,
      startTimeoutMs: 60_000,
    })
    this.controller = controller
    appendHarnessLog(this.options.userData, mode, `[desktop] boot mode=${mode} home=${mode === 'safe' ? '<userData>/safe-runtime/harness' : '<userData>/harness'}\n`)
    await controller.start()
    const snapshot = await controller.waitUntilReady()
    appendHarnessLog(this.options.userData, mode, `[desktop] boot result phase=${snapshot.phase} message=${snapshot.message}\n`)
    return snapshot
  }

  /** Install the verified bundled Workbench into a new packaged profile. */
  private async ensureBundledWorkbench(environment: Record<string, string>): Promise<void> {
    const pm = this.options.profileManager
    if (!pm.workbenchArtifactConfigured) return
    const profileDir = join(pm.dshHome, 'profiles/web')
    let hasWorkbench = false
    if (existsSync(join(profileDir, 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        hasWorkbench = manifest.dependencies?.['@icomposer/workbench'] !== undefined
      } catch {
        // The normal boot will report a malformed manifest on the failure page.
      }
    }
    if (hasWorkbench) return
    const cached = pm.ensureWorkbenchArtifact()
    const operationId = `bundled-workbench-${Date.now()}`
    const staging = pm.materializeStagingProfile(operationId)
    const beforeDeps = new Set(Object.keys(BundleReconciler.readManifest(staging).dependencies ?? {}))
    const result = await PnpmLauncher.run({
      nodePath: this.options.nodePath,
      pnpmEntry: this.options.pnpmEntry,
      cwd: staging,
      environment,
      runAsNode: this.options.runAsNode,
      timeoutMs: 300_000,
    }, 'add', ['--save-exact', `file:${cached}`])
    if (result.exitCode !== 0) throw new Error(`bundled Workbench install failed: ${result.stderr.slice(-600)}`)
    BundleReconciler.reconcile(staging, beforeDeps)
    pm.activateStagedProfile(staging, operationId)
  }

  /**
   * Materialize (once) and install the safe home profile: base+web-app from
   * the pinned runtime graph, no home patch layer, no workbench, no
   * third-party plugins. The normal home is never modified.
   */
  private async prepareSafeHome(environment: Record<string, string>): Promise<string> {
    const safeHome = this.options.profileManager.materializeSafeHome({
      version: this.options.runtimePin,
      packages: readRuntimePackages(appRoot()),
    })
    this.safeHome = safeHome
    const profileDir = join(safeHome, 'profiles/web')
    const marker = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
    if (!existsSync(marker)) {
      const pin = this.options.runtimePin
      const result = await PnpmLauncher.run({
        nodePath: this.options.nodePath,
        pnpmEntry: this.options.pnpmEntry,
        cwd: profileDir,
        environment,
        runAsNode: this.options.runAsNode,
        timeoutMs: 300_000,
      }, 'add', ['--save-exact', `@deepseek-ai/dsh-base@${pin}`, `@deepseek-ai/dsh-web-app@${pin}`])
      if (result.exitCode !== 0) throw new Error(`safe home install failed: ${result.stderr.slice(-600)}`)
      this.options.profileManager.healStagingPeerFarm(profileDir)
      BundleReconciler.reconcile(profileDir)
    }
    return safeHome
  }
}

/** Read the pinned runtime version from the audit config. */
export function readRuntimePin(repoRoot: string): string {
  const configPath = join(repoRoot, 'config/runtime-pins.json')
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { version?: string }
    return config.version ?? '0.1.0-rc.7'
  } catch {
    return '0.1.0-rc.7'
  }
}

export function readRuntimePackages(repoRoot: string): string[] {
  const configPath = join(repoRoot, 'config/runtime-pins.json')
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { packages?: string[] }
    return config.packages ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  } catch {
    return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }
}
