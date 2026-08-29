import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { PreviousInstallerReceipt, RollbackResult } from './contracts.ts'
import { verifyUpgradeSnapshot, restoreUpgradeSnapshot } from './upgrade-snapshot.ts'
import type { ProfileManager } from '../profile/profile-manager.ts'

export interface RollbackManagerOptions {
  userData: string
  profileManager: ProfileManager
}

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

/**
 * E09 rollback boundaries. Desktop rollback deliberately returns a manual
 * reinstall instruction; it never silently installs an older executable.
 */
export class RollbackManager {
  private readonly userData: string
  private readonly profileManager: ProfileManager

  constructor(options: RollbackManagerOptions) {
    this.userData = options.userData
    this.profileManager = options.profileManager
  }

  rollbackDesktop(receipt: PreviousInstallerReceipt): RollbackResult {
    const installerPath = isAbsolute(receipt.path) ? receipt.path : join(this.userData, receipt.path)
    if (!receipt.signature.verified) return { kind: 'desktop', ok: false, message: 'previous installer is not signed', requiresUserAction: true }
    if (!existsSync(installerPath) || hash(installerPath) !== receipt.sha256) return { kind: 'desktop', ok: false, message: 'previous signed installer hash mismatch', requiresUserAction: true }
    return { kind: 'desktop', ok: true, message: 'reinstall the verified previous installer manually; userData is retained', requiresUserAction: true, artifactSha256: receipt.sha256 }
  }

  rollbackHarness(snapshotPath: string): RollbackResult {
    try {
      const manifest = restoreUpgradeSnapshot(snapshotPath, this.userData)
      return { kind: 'harness', ok: true, message: 'restored verified profile/session/settings snapshot', snapshotId: manifest.snapshotId }
    } catch (error) {
      return { kind: 'harness', ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  rollbackWorkbench(previousTgz: string, expectedSha256: string): RollbackResult {
    if (!existsSync(previousTgz) || hash(previousTgz) !== expectedSha256) return { kind: 'workbench', ok: false, message: 'previous Workbench artifact hash mismatch' }
    try {
      const destination = join(this.userData, 'artifact-cache/workbench', `${expectedSha256}.tgz`)
      mkdirSync(join(this.userData, 'artifact-cache/workbench'), { recursive: true })
      copyFileSync(previousTgz, destination)
      const journal = this.profileManager.readJournal()
      if (journal?.phase === 'committed' && existsSync(journal.prevDir)) this.profileManager.rollbackToPreviousGeneration(`workbench-${expectedSha256.slice(0, 12)}`)
      return { kind: 'workbench', ok: true, message: 'previous verified Workbench tgz cached and prior profile generation restored; restart uses it', artifactSha256: expectedSha256 }
    } catch (error) {
      return { kind: 'workbench', ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  rollbackPlugin(operationId?: string): RollbackResult {
    const journal = this.profileManager.readJournal()
    if (journal?.phase !== 'committed' || !existsSync(journal.prevDir)) return { kind: 'plugin', ok: false, message: 'no previous verified plugin generation' }
    try {
      this.profileManager.rollbackToPreviousGeneration(`rollback-${operationId ?? 'last'}`)
      return { kind: 'plugin', ok: true, message: 'restored previous verified plugin profile generation' }
    } catch (error) {
      return { kind: 'plugin', ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  verifySnapshot(snapshotPath: string): string {
    return verifyUpgradeSnapshot(snapshotPath).snapshotId
  }
}
