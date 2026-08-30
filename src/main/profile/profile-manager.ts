import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, renameSync, readdirSync, symlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { openSync, closeSync, fsyncSync } from 'node:fs'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)

export type JournalPhase =
  | 'prepared'
  | 'intent_move_old'
  | 'old_moved'
  | 'intent_activate'
  | 'candidate_active'
  | 'boot_ready'
  | 'committed'

export interface OperationJournal {
  operationId: string
  phase: JournalPhase
  oldProfileHash: string
  targetSpecDigest: string
  candidateDir: string
  currentDir: string
  prevDir: string
  updatedAt: number
}

export interface ProfileManagerOptions {
  userData: string
  /** Absolute path to the DSH home root (parent of profiles/). */
  dshHome: string
  /** Absolute path to the pnpm JS entry. */
  pnpmEntry: string
  /** Absolute path to the bundled Node executable. */
  nodePath: string
  /** Absolute runtime installation anchor used for peer-resolution in packaged builds. */
  runtimeAnchor?: string
  /** Absolute path of the workbench tgz artifact. Optional for plugin-only operations. */
  workbenchTgzPath?: string
  /** Expected SHA256 of the workbench tgz. Optional for plugin-only operations. */
  workbenchSha256?: string
  /** Explicit opt-in for an Electron executable used as Node. */
  runAsNode?: boolean
}

const PROFILE_DIR = 'profiles/web'
const SAFE_HOME = 'safe-runtime/harness'

export class ProfileManager {
  readonly userData: string
  readonly dshHome: string
  readonly runtimeAnchor: string | undefined
  private readonly pnpmEntry: string
  private readonly nodePath: string
  private readonly workbenchTgzPath: string
  private readonly workbenchSha256: string
  private readonly runAsNode: boolean
  private readonly stagingRoot: string
  private readonly journalPath: string

  constructor(options: ProfileManagerOptions) {
    this.userData = options.userData
    this.dshHome = options.dshHome
    this.runtimeAnchor = options.runtimeAnchor
    this.pnpmEntry = options.pnpmEntry
    this.nodePath = options.nodePath
    this.workbenchTgzPath = options.workbenchTgzPath ?? ''
    this.workbenchSha256 = options.workbenchSha256 ?? ''
    this.runAsNode = options.runAsNode === true
    this.stagingRoot = join(this.dshHome, '.staging')
    this.journalPath = join(this.userData, 'desktop-state', 'profile-operation.json')
  }

  static sha256(filePath: string): string {
    const hash = createHash('sha256')
    hash.update(readFileSync(filePath))
    return hash.digest('hex')
  }

  static ensureDir(path: string): void {
    mkdirSync(path, { recursive: true })
  }

  /** Read the current web profile's manifest hash, or '' when absent. */
  currentProfileHash(): string {
    const manifest = join(this.dshHome, PROFILE_DIR, 'package.json')
    if (!existsSync(manifest)) return ''
    return createHash('sha256').update(readFileSync(manifest)).digest('hex')
  }

  /** Whether this manager has a verified bundled Workbench artifact configured. */
  get workbenchArtifactConfigured(): boolean {
    return this.workbenchTgzPath !== '' && this.workbenchSha256 !== ''
  }

  /**
   * Verify the workbench artifact and copy it into the stable artifact cache.
   * Returns the cached tgz path.
   */
  ensureWorkbenchArtifact(): string {
    if (this.workbenchTgzPath === '' || this.workbenchSha256 === '') {
      throw new Error('workbench artifact not configured')
    }
    if (ProfileManager.sha256(this.workbenchTgzPath) !== this.workbenchSha256) {
      throw new Error(`workbench tgz hash mismatch: expected ${this.workbenchSha256}`)
    }
    const cacheDir = join(this.userData, 'artifact-cache', 'workbench')
    ProfileManager.ensureDir(cacheDir)
    const cached = join(cacheDir, `${this.workbenchSha256}.tgz`)
    if (!existsSync(cached)) {
      cpSync(this.workbenchTgzPath, cached)
    }
    return cached
  }

  /**
   * Materialize the peer-resolution symlink farm inside a staging profile's
   * node_modules, mirroring the official `healProfilesModuleFallback` closure
   * (BFS over dependencies+peerDependencies from the dsh install anchor).
   * This lets pnpm resolve `@deepseek-ai/*` peers while installing an
   * out-of-tree bundle and lets the activated profile resolve them at boot.
   */
  healStagingPeerFarm(stagingDir: string): void {
    const { execFileSync } = require2('node:child_process') as typeof import('node:child_process')
    const nodeEnvironment = { ...process.env }
    delete nodeEnvironment.ELECTRON_RUN_AS_NODE
    if (this.runAsNode) nodeEnvironment.ELECTRON_RUN_AS_NODE = '1'
    const appAnchor = execFileSync(this.nodePath, ['-e', "console.log(require.resolve('@deepseek-ai/dsh/package.json'))"], {
      cwd: this.runtimeAnchor ?? process.cwd(),
      encoding: 'utf8',
      env: nodeEnvironment,
    }).trim()
    const links = new Map<string, string>()
    const queue: Array<{ anchor: string; manifest: Record<string, unknown> }> = []
    const readManifest = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))
    const appManifest = readManifest(appAnchor)
    if (typeof appManifest.name === 'string') links.set(appManifest.name, dirname(appAnchor))
    queue.push({ anchor: appAnchor, manifest: appManifest })
    const packageDirFromAnchor = (anchor: string, name: string): string | undefined => {
      const anchorDir = dirname(anchor)
      const candidates = [
        join(anchorDir, 'node_modules', name),
        join(anchorDir, name),
      ]
      for (const candidate of candidates) {
        if (existsSync(join(candidate, 'package.json'))) return candidate
      }
      return undefined
    }
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const deps = [
        ...Object.keys((next.manifest.dependencies ?? {}) as Record<string, unknown>),
        ...Object.keys((next.manifest.peerDependencies ?? {}) as Record<string, unknown>),
      ]
      for (const dep of deps) {
        if (links.has(dep)) continue
        const dir = packageDirFromAnchor(next.anchor, dep)
        if (dir === undefined) continue
        links.set(dep, dir)
        queue.push({ anchor: join(dir, 'package.json'), manifest: readManifest(join(dir, 'package.json')) })
      }
    }
    const farmDir = join(stagingDir, 'node_modules')
    ProfileManager.ensureDir(farmDir)
    for (const [packageName, target] of links) {
      const link = join(farmDir, packageName)
      ProfileManager.ensureDir(dirname(link))
      try {
        rmSync(link, { force: true })
      } catch {
        // A non-symlink real directory is left in place for pnpm to manage.
      }
      try {
        symlinkSync(target, link, 'junction')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  /**
   * Materialize a fresh staging copy of the web profile: copy the current
   * profile, or initialize a new one from the standard web template via the
   * DSH app-boot profile template when no profile exists yet.
   */
  materializeStagingProfile(operationId: string): string {
    const staging = join(this.stagingRoot, operationId, 'profiles/web')
    ProfileManager.ensureDir(dirname(staging))
    const current = join(this.dshHome, PROFILE_DIR)
    if (existsSync(current)) {
      cpSync(current, staging, { recursive: true })
    } else {
      ProfileManager.ensureDir(staging)
      writeFileSync(join(staging, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }, null, 2) + '\n')
      writeFileSync(join(staging, 'cordis.patch.yml'), '# profile patch layer\n[]\n')
      writeFileSync(join(staging, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    }
    // Resolve @deepseek-ai/* peers exactly as the official CLI does at boot.
    this.healStagingPeerFarm(staging)
    return staging
  }

  /** Read the current journal, or undefined. */
  readJournal(): OperationJournal | undefined {
    if (!existsSync(this.journalPath)) return undefined
    return JSON.parse(readFileSync(this.journalPath, 'utf8')) as OperationJournal
  }

  private writeJournal(journal: OperationJournal): void {
    ProfileManager.ensureDir(dirname(this.journalPath))
    const file = openSync(this.journalPath, 'w')
    try {
      writeFileSync(this.journalPath, JSON.stringify(journal, null, 2) + '\n')
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
  }

  private durableRename(from: string, to: string): void {
    ProfileManager.ensureDir(dirname(to))
    if (process.platform === 'win32') {
      let last: unknown
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { renameSync(from, to); return } catch (error) {
          last = error
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
        }
      }
      throw last
    }
    renameSync(from, to)
    // POSIX: fsync parent directories of source and target for crash durability.
    for (const dir of [dirname(from), dirname(to)]) {
      const fd = openSync(dir, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
    }
  }

  /**
   * Two-phase crash-consistent activation of a staging profile over the
   * current web profile. Writes intent journal entries before each
   * irreversible filesystem operation and keeps the previous generation
   * until the next successful commit.
   */
  activateStagedProfile(stagingDir: string, operationId: string): string {
    const current = join(this.dshHome, PROFILE_DIR)
    const prev = join(this.dshHome, PROFILE_DIR + '.prev')
    const journal: OperationJournal = {
      operationId,
      phase: 'prepared',
      oldProfileHash: this.currentProfileHash(),
      targetSpecDigest: ProfileManager.sha256(stagingDir + '/package.json'),
      candidateDir: stagingDir,
      currentDir: current,
      prevDir: prev,
      updatedAt: Date.now(),
    }
    this.writeJournal(journal)

    // Step 1: move current -> prev.
    if (existsSync(current)) {
      journal.phase = 'intent_move_old'
      this.writeJournal(journal)
      if (existsSync(prev)) rmSync(prev, { recursive: true, force: true })
      this.durableRename(current, prev)
      journal.phase = 'old_moved'
      this.writeJournal(journal)
    }

    // Step 2: activate candidate -> current.
    journal.phase = 'intent_activate'
    this.writeJournal(journal)
    this.durableRename(stagingDir, current)
    journal.phase = 'candidate_active'
    this.writeJournal(journal)

    // Step 3: commit (candidate is ready; keep prev until next success).
    journal.phase = 'committed'
    this.writeJournal(journal)
    return current
  }

  /**
   * Crash-consistent rollback to the previous verified generation.
   * Writes intent journal entries covering the destructive window
   * (rm current / rename prev) so recover() completes the rollback
   * if the process dies mid-operation.
   */
  rollbackToPreviousGeneration(operationId: string): string {
    const current = join(this.dshHome, PROFILE_DIR)
    const prev = join(this.dshHome, PROFILE_DIR + '.prev')
    const journal: OperationJournal = {
      operationId,
      phase: 'prepared',
      oldProfileHash: this.currentProfileHash(),
      targetSpecDigest: '',
      candidateDir: join(this.dshHome, PROFILE_DIR + '.rollback-candidate'),
      currentDir: current,
      prevDir: prev,
      updatedAt: Date.now(),
    }
    this.writeJournal(journal)
    // 'intent_activate' recovery semantics restore prev over current —
    // exactly the rollback goal, so a crash here is self-healing.
    journal.phase = 'intent_activate'
    this.writeJournal(journal)
    if (existsSync(current)) rmSync(current, { recursive: true, force: true })
    this.durableRename(prev, current)
    journal.phase = 'committed'
    this.writeJournal(journal)
    return current
  }

  /**
   * Crash recovery: read the journal and the filesystem matrix, and restore
   * the previous generation when the candidate was not committed.
   */
  recover(): void {
    const journal = this.readJournal()
    if (journal === undefined) return
    const currentExists = existsSync(journal.currentDir)
    const prevExists = existsSync(journal.prevDir)
    const candidateExists = existsSync(journal.candidateDir)
    if (journal.phase === 'committed') return
    if (journal.phase === 'old_moved' || journal.phase === 'intent_activate') {
      // Candidate may or may not be active; prefer prev.
      if (currentExists && prevExists && !candidateExists) {
        // Candidate was activated but phase not written; isolate candidate.
        rmSync(journal.currentDir, { recursive: true, force: true })
        this.durableRename(journal.prevDir, journal.currentDir)
      } else if (prevExists) {
        rmSync(journal.currentDir, { recursive: true, force: true })
        this.durableRename(journal.prevDir, journal.currentDir)
      }
      // If neither exists, leave as-is (manual recovery page).
    }
    // candidate_active / boot_ready: same restore-prev behavior.
    if (journal.phase === 'candidate_active' || journal.phase === 'boot_ready') {
      if (prevExists) {
        rmSync(journal.currentDir, { recursive: true, force: true })
        this.durableRename(journal.prevDir, journal.currentDir)
      }
    }
  }

  /** Initialize the safe (core-only) home from the web template. */
  materializeSafeHome(runtimePins?: { version: string; packages: readonly string[] }): string {
    const safeHome = join(this.userData, SAFE_HOME)
    const safeProfile = join(safeHome, PROFILE_DIR)
    ProfileManager.ensureDir(safeProfile)
    writeFileSync(join(safeProfile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web-safe',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n')
    writeFileSync(join(safeProfile, 'cordis.patch.yml'), '# safe profile patch layer\n[]\n')
    const pins = runtimePins ?? { version: '0.1.0-rc.7', packages: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }
    const overrides = pins.packages.map(name => `  '${name}': ${pins.version}`).join('\n')
    writeFileSync(join(safeProfile, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  electron: true\n  esbuild: true\n  koffi: true\n  node-pty: true\n  protobufjs: true\noverrides:\n${overrides}\n`)
    return safeHome
  }
}
