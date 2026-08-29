export type RollbackKind = 'desktop' | 'harness' | 'workbench' | 'plugin'

export interface CompatibilityManifest {
  schemaVersion: 1
  desktop: { version: string; runtimeManifestSchema: number; upgradeSnapshotSchema: number }
  dsh: { version: string; runtimeGraph: string; profileSchema: number; sessionSchema: number }
  workbench: { version: string; sha256: string; profileSchema: number }
  profile: { schemaVersion: number; layout: string; requiredFiles: string[] }
  session: { schemaVersion: number; format: string; migration: string }
}

export interface SnapshotFile {
  path: string
  kind: 'file' | 'symlink'
  size: number
  sha256: string
  target?: string
}

export interface UpgradeSnapshotManifest {
  schemaVersion: 1
  snapshotId: string
  createdAt: string
  compatibility: Pick<CompatibilityManifest, 'desktop' | 'dsh' | 'workbench' | 'profile' | 'session'>
  roots: string[]
  authState: 'schema-only-not-token-store'
  files: SnapshotFile[]
  sha256: string
}

export interface PreviousInstallerReceipt {
  schemaVersion: 1
  platform: 'darwin' | 'win32'
  version: string
  path: string
  sha256: string
  signature: { verified: boolean; method: 'codesign-deep-strict' | 'authenticode'; subject?: string }
  recordedAt: string
}

export interface RollbackResult {
  kind: RollbackKind
  ok: boolean
  message: string
  requiresUserAction?: boolean
  snapshotId?: string
  artifactSha256?: string
}

export interface ReleaseReceipt {
  schemaVersion: 1
  releaseVersion: string
  recordedAt: string
  platform: string
  arch: string
  developmentOnly: boolean
  compatibility: CompatibilityManifest
  artifacts: Array<{
    path: string
    kind: 'file' | 'directory'
    size: number
    sha256: string
    manifestSha256?: string
    manifestEntries?: number
    signature: {
      verified: boolean
      method: string
      subject?: string
      team?: string
      runtime?: string
      notarized: boolean
      verifiedAt: string
    }
  }>
  evidence: {
    commands: string[]
    resourceManifest: { entries: number; verified: boolean }
    sbom: { components: number; nativeFiles: number; unknownLicenses: number; sha256: string }
    scan: { sourceMaps: number; testPaths: number; absoluteDevPaths: number; tokenLike: number; sha256: string }
    packagedSmoke: { ok: boolean; path: string }
    orphanProcesses: number
  }
  previousInstallerPolicy: 'signed-only-manual-reinstall'
  residualRisks: string[]
}
