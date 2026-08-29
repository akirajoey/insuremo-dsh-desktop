import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CompatibilityManifest, PreviousInstallerReceipt, RollbackResult, UpgradeSnapshotManifest } from './contracts.ts'
import { assertCompatibilityShape, readCompatibility } from './compatibility.ts'
import { createUpgradeSnapshot } from './upgrade-snapshot.ts'
import { RollbackManager } from './rollback-manager.ts'
import type { ProfileManager } from '../profile/profile-manager.ts'

export interface UpgradeManagerOptions {
  userData: string
  appPath: string
  profileManager: ProfileManager
}

/** Coordinates E09 snapshots and the four explicit rollback boundaries. */
export class UpgradeManager {
  private readonly options: UpgradeManagerOptions
  private readonly compatibility: CompatibilityManifest
  private readonly rollback: RollbackManager

  constructor(options: UpgradeManagerOptions) {
    this.options = options
    this.compatibility = readCompatibility(join(options.appPath, 'compatibility.json'))
    this.rollback = new RollbackManager({ userData: options.userData, profileManager: options.profileManager })
  }

  get compatibilityManifest(): CompatibilityManifest { return this.compatibility }

  snapshot(): UpgradeSnapshotManifest {
    return createUpgradeSnapshot({ userData: this.options.userData, compatibility: this.compatibility })
  }

  validateCompatibility(): void { assertCompatibilityShape(this.compatibility) }

  rollbackDesktop(receipt: PreviousInstallerReceipt): RollbackResult { return this.rollback.rollbackDesktop(receipt) }
  rollbackHarness(snapshotPath: string): RollbackResult { return this.rollback.rollbackHarness(snapshotPath) }
  rollbackWorkbench(path: string, sha256: string): RollbackResult { return this.rollback.rollbackWorkbench(path, sha256) }
  rollbackPlugin(operationId?: string): RollbackResult { return this.rollback.rollbackPlugin(operationId) }

  previousSnapshotPath(snapshotId: string): string {
    const path = join(this.options.userData, 'desktop-state/upgrades', snapshotId, 'snapshot')
    if (!existsSync(join(path, 'manifest.json'))) throw new Error('upgrade snapshot not found')
    return path
  }
}
