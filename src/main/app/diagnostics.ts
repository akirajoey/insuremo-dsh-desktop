import type { FailureDiagnostics } from '../../shared/failure-api.ts'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { logTail, harnessLogPath } from './logs.ts'
import type { ProfileManager } from '../profile/profile-manager.ts'
import { sanitizeErrorMessage } from '../plugins/plugin-service.ts'

export interface DiagnosticsContext {
  mode: 'normal' | 'safe'
  phase: string
  message: string
  stderrTail: string
  profileHome?: string
}

/** Collects local, harness-independent diagnostics for the failure page. */
export class DiagnosticsService {
  private readonly pm: ProfileManager
  private readonly userData: string

  constructor(pm: ProfileManager, userData: string) {
    this.pm = pm
    this.userData = userData
  }

  collect(context: DiagnosticsContext): FailureDiagnostics {
    const profileHome = context.profileHome ?? (context.mode === 'safe' ? join(this.userData, 'safe-runtime/harness') : this.pm.dshHome)
    const profileDir = join(profileHome, 'profiles/web')
    const manifestPath = join(profileDir, 'package.json')
    let dependencies: Record<string, string> = {}
    let bundles: string[] = []
    let exists = false
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
        dependencies = manifest.dependencies ?? {}
        bundles = manifest.dsh?.profile?.bundles ?? []
        exists = true
      } catch {
        exists = false
      }
    }
    const missingModules = Object.keys(dependencies).filter(name => !existsSync(join(profileDir, 'node_modules', name)))
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    let lockfileSha256: string | null = null
    let lockfileParses: boolean | null = null
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, 'utf8')
      lockfileSha256 = createHash('sha256').update(raw).digest('hex')
      try {
        parseYaml(raw)
        lockfileParses = true
      } catch {
        lockfileParses = false
      }
    }
    const bases = [this.pm.userData, this.pm.dshHome]
    return {
      mode: context.mode,
      phase: context.phase,
      message: sanitizeErrorMessage(context.message, bases),
      stderrTail: sanitizeErrorMessage(context.stderrTail, bases),
      profile: {
        dir: `<home>/${relative(profileHome, profileDir)}`,
        exists,
        dependencies,
        bundles,
        missingModules,
        lockfileSha256,
        lockfileParses,
      },
      provenanceTail: this.readProvenanceTail(),
      logTail: sanitizeErrorMessage(logTail(harnessLogPath(this.userData, context.mode), 120), bases),
    }
  }

  private readProvenanceTail(): FailureDiagnostics['provenanceTail'] {
    try {
      const provenancePath = join(this.pm.userData, 'desktop-state', 'plugin-provenance.json')
      if (!existsSync(provenancePath)) return []
      const records = JSON.parse(readFileSync(provenancePath, 'utf8')) as FailureDiagnostics['provenanceTail']
      return records.slice(-5)
    } catch {
      return []
    }
  }
}
