import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { PnpmLauncher } from '../profile/pnpm-launcher.ts'
import { BundleReconciler } from '../profile/bundle-reconciler.ts'
import { ProfileManager, type OperationJournal } from '../profile/profile-manager.ts'
import type { PluginOperation, PluginOperationResult, PluginProvenance, PluginSpec, PluginEntry } from './contracts.ts'
import { parsePluginSpec, specToPnpmArg, specDigest } from './spec-parser.ts'

export interface PluginServiceOptions {
  profileManager: ProfileManager
  /** Directory where tgz/local capability payloads are snapshotted. */
  capabilityDir: string
  pnpmEntry: string
  nodePath: string
  /** Shell environment used by every desktop-side pnpm invocation. */
  environment?: Record<string, string>
  /** Explicit opt-in for an Electron executable used as Node. */
  runAsNode?: boolean
  workbenchName: string
}

export interface PluginServiceState {
  /** Map of capability id -> payload path for one-time native-picked payloads. */
  capabilities: Map<string, string>
  provenancePath: string
}

const WORKBENCH = '@icomposer/workbench'

/**
 * Redact absolute machine paths from error messages before they reach the
 * renderer: known bases become <redacted>, remaining user/tmp/home paths
 * become <path>.
 */
export function sanitizeErrorMessage(raw: string, bases: readonly string[]): string {
  let message = raw
  for (const base of bases) {
    if (base !== '') message = message.split(base).join('<redacted>')
  }
  return message.replace(/(?:\/(?:Users|tmp|private|var|home)\/[^\s"',:)\]]+)/g, '<path>')
}

export class PluginService {
  private readonly pm: ProfileManager
  private readonly capabilityDir: string
  private readonly pnpmEntry: string
  private readonly nodePath: string
  private readonly environment: Record<string, string> | undefined
  private readonly runAsNode: boolean
  private readonly workbenchName: string
  private readonly capabilities = new Map<string, string>()
  private readonly provenancePath: string

  constructor(options: PluginServiceOptions) {
    this.pm = options.profileManager
    this.capabilityDir = options.capabilityDir
    this.pnpmEntry = options.pnpmEntry
    this.nodePath = options.nodePath
    this.environment = options.environment
    this.runAsNode = options.runAsNode === true
    this.workbenchName = options.workbenchName
    this.provenancePath = join(options.profileManager.userData, 'desktop-state', 'plugin-provenance.json')
  }

  /** Register a one-time capability for a native-picked tgz/local payload. */
  registerCapability(id: string, payloadPath: string): void {
    if (!existsSync(payloadPath)) throw new Error(`plugin: capability payload missing: ${payloadPath}`)
    this.capabilities.set(id, payloadPath)
  }

  /** Consume a one-time capability: the id is deleted on first use. */
  consumeCapability(id: string): string {
    const payload = this.capabilities.get(id)
    if (payload === undefined) throw new Error(`plugin: unknown or already-consumed capability ${id}`)
    this.capabilities.delete(id)
    return payload
  }

  listPlugins(): PluginEntry[] {
    const profileDir = join(this.pm.dshHome, 'profiles/web')
    const manifest = BundleReconciler.readManifest(profileDir)
    const dependencies = manifest.dependencies ?? {}
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const entries: PluginEntry[] = []
    for (const [name, rawVersion] of Object.entries(dependencies)) {
      const installed = BundleReconciler.readDependencyManifest(profileDir, name)
      entries.push({
        name,
        version: typeof rawVersion === 'string' ? rawVersion : String(rawVersion),
        description: installed?.description,
        isBundle: bundles.includes(name),
        isWorkbench: name === this.workbenchName,
      })
    }
    return entries
  }

  private currentProfileDir(): string {
    return join(this.pm.dshHome, 'profiles/web')
  }

  private snapshotPayload(spec: PluginSpec): { path: string; tgzSha256?: string } {
    if (spec.kind !== 'tgz' && spec.kind !== 'local') throw new Error('plugin: snapshot requires tgz/local capability')
    const payload = this.consumeCapability(spec.capabilityId)
    mkdirSync(this.capabilityDir, { recursive: true })
    if (spec.kind === 'local') {
      // Snapshot the local directory into the cache (excluding node_modules).
      const dest = join(this.capabilityDir, `${createHash('sha256').update(payload).digest('hex').slice(0, 16)}-local`)
      if (!existsSync(dest)) cpSync(payload, dest, { recursive: true, filter: source => !source.includes('/node_modules/') })
      return { path: dest }
    }
    const sha = createHash('sha256').update(readFileSync(payload)).digest('hex')
    const dest = join(this.capabilityDir, `${sha}.tgz`)
    if (!existsSync(dest)) {
      copyFileSync(payload, dest)
    }
    return { path: dest, tgzSha256: sha }
  }

  private async runPnpm(verb: 'add' | 'update' | 'remove', args: string[]): Promise<{ ok: boolean; stderr: string }> {
    const result = await PnpmLauncher.run({
      nodePath: this.nodePath,
      pnpmEntry: this.pnpmEntry,
      cwd: this.currentProfileDir(),
      environment: this.environment,
      runAsNode: this.runAsNode,
      timeoutMs: 180_000,
    }, verb, args)
    return { ok: result.exitCode === 0, stderr: result.stderr }
  }

  private writeProvenance(provenance: PluginProvenance): void {
    const records = this.readProvenance()
    records.push(provenance)
    mkdirSync(join(this.pm.userData, 'desktop-state'), { recursive: true })
    writeFileSync(this.provenancePath, JSON.stringify(records, null, 2))
  }

  private readProvenance(): PluginProvenance[] {
    if (!existsSync(this.provenancePath)) return []
    return JSON.parse(readFileSync(this.provenancePath, 'utf8')) as PluginProvenance[]
  }

  private lockfileIntegrity(): string {
    const lock = join(this.currentProfileDir(), 'pnpm-lock.yaml')
    if (!existsSync(lock)) return ''
    return createHash('sha256').update(readFileSync(lock)).digest('hex')
  }

  async runOperation(operation: PluginOperation, input: string, capabilityId?: string): Promise<PluginOperationResult> {
    if (operation === 'rebuild') throw new Error('plugin: use rebuild() for profile rebuilds')
    const operationId = randomUUID()
    try {
      const spec: PluginSpec = capabilityId !== undefined
        ? { kind: capabilityId.startsWith('tgz:') ? 'tgz' : 'local', capabilityId: capabilityId.slice(capabilityId.indexOf(':') + 1) } as PluginSpec
        : parsePluginSpec(input)
      const requestedSpecDigest = specDigest(spec)
      // tgz/local capability: snapshot the payload into the artifact cache.
      let pnpmArg: string
      let tgzSha256: string | undefined
      if (spec.kind === 'tgz' || spec.kind === 'local') {
        const snapshot = this.snapshotPayload(spec)
        pnpmArg = `file:${snapshot.path}`
        tgzSha256 = snapshot.tgzSha256
      } else {
        pnpmArg = specToPnpmArg(spec)
      }

      const staging = this.pm.materializeStagingProfile(operationId)
      const beforeDeps = new Set(Object.keys(BundleReconciler.readManifest(staging).dependencies ?? {}))
      const stagedPnpm = await PnpmLauncher.run({
        nodePath: this.nodePath,
        pnpmEntry: this.pnpmEntry,
        cwd: staging,
        environment: this.environment,
        runAsNode: this.runAsNode,
        timeoutMs: 180_000,
      }, operation === 'remove' ? 'remove' : 'add', operation === 'remove' ? [input] : [pnpmArg])
      if (stagedPnpm.exitCode !== 0) throw new Error(`staged pnpm failed: ${stagedPnpm.stderr.slice(0, 500)}`)

      BundleReconciler.reconcile(staging, beforeDeps)
      this.pm.activateStagedProfile(staging, operationId)

      const manifest = BundleReconciler.readManifest(this.currentProfileDir())
      const resolvedName = spec.kind === 'alias' ? spec.alias
        : spec.kind === 'npm' ? spec.package
        : spec.kind === 'git' ? spec.url
        : input
      const provenance: PluginProvenance = {
        operationId,
        operation,
        requestedSpecDigest,
        resolvedName,
        resolvedVersion: (manifest.dependencies ?? {})[resolvedName] ?? '',
        lockfileIntegrity: this.lockfileIntegrity(),
        tgzSha256,
        installedAt: Date.now(),
        outcome: 'committed',
      }
      this.writeProvenance(provenance)
      return { operationId, operation, ok: true, message: 'committed', provenance }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      return { operationId, operation, ok: false, message: sanitizeErrorMessage(raw, [this.pm.userData, this.pm.dshHome, this.capabilityDir, homedir(), tmpdir()]) }
    }
  }

  /**
   * E06 recovery: rebuild the current profile from its own manifest in a
   * staging copy (pnpm install from the lockfile), reconcile bundles, and
   * activate through the standard two-phase switch. Used when no previous
   * generation exists to roll back to. Never deletes user plugins from the
   * manifest — it reinstalls exactly what the manifest lists.
   */
  async rebuild(): Promise<PluginOperationResult> {
    const operationId = randomUUID()
    try {
      const staging = this.pm.materializeStagingProfile(operationId)
      const beforeDeps = new Set(Object.keys(BundleReconciler.readManifest(staging).dependencies ?? {}))
      const stagedPnpm = await PnpmLauncher.run({
        nodePath: this.nodePath,
        pnpmEntry: this.pnpmEntry,
        cwd: staging,
        environment: this.environment,
        runAsNode: this.runAsNode,
        timeoutMs: 300_000,
      }, 'install', [])
      if (stagedPnpm.exitCode !== 0) throw new Error(`staged pnpm rebuild failed: ${stagedPnpm.stderr.slice(0, 500)}`)
      BundleReconciler.reconcile(staging, beforeDeps)
      this.pm.activateStagedProfile(staging, operationId)
      const manifest = BundleReconciler.readManifest(this.currentProfileDir())
      const provenance: PluginProvenance = {
        operationId,
        operation: 'rebuild',
        requestedSpecDigest: createHash('sha256').update(JSON.stringify(manifest.dependencies ?? {})).digest('hex'),
        resolvedName: '(profile)',
        resolvedVersion: '',
        lockfileIntegrity: this.lockfileIntegrity(),
        installedAt: Date.now(),
        outcome: 'committed',
      }
      this.writeProvenance(provenance)
      return { operationId, operation: 'rebuild', ok: true, message: 'rebuilt from manifest', provenance }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      return { operationId, operation: 'rebuild', ok: false, message: sanitizeErrorMessage(raw, [this.pm.userData, this.pm.dshHome, this.capabilityDir, homedir(), tmpdir()]) }
    }
  }

  async rollback(operationId?: string): Promise<PluginOperationResult> {
    const records = this.readProvenance()
    const target = operationId !== undefined
      ? records.find(r => r.operationId === operationId)
      : records.filter(r => r.outcome === 'committed').at(-1)
    if (target === undefined) return { operationId: operationId ?? 'last', operation: 'rollback', ok: false, message: 'no committed operation to roll back' }
    const journal = this.pm.readJournal()
    if (journal === undefined || journal.phase !== 'committed') {
      return { operationId: target.operationId, operation: 'rollback', ok: false, message: 'no verified previous generation' }
    }
    const prev = join(this.pm.dshHome, 'profiles/web.prev')
    if (!existsSync(join(prev, 'package.json'))) {
      return { operationId: target.operationId, operation: 'rollback', ok: false, message: 'previous generation missing' }
    }
    this.pm.rollbackToPreviousGeneration(`rollback-${target.operationId}`)
    const provenance: PluginProvenance = { ...target, outcome: 'rolled_back', installedAt: Date.now() }
    this.writeProvenance(provenance)
    return { operationId: target.operationId, operation: 'rollback', ok: true, message: 'rolled back to previous verified generation' }
  }
}
