/**
 * Cross-platform resolver for the current pnpm JavaScript entry
 * (bin/pnpm.cjs) shared by tests, the fixture builder, and the size probe.
 *
 * Priority: explicit DSH_TEST_PNPM_ENTRY / DSH_PNPM_ENTRY → repo-local
 * node_modules → npm_execpath (realpath) → platform-aware command lookup
 * (`where.exe` on Windows, `which` elsewhere) with realpath and the usual
 * global install layouts. Never hardcodes a host prefix.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the pnpm JS entry; throws with a actionable message when absent. */
export function resolvePnpmEntry(environment = process.env, repoRoot = defaultRepoRoot()) {
  for (const key of ['DSH_TEST_PNPM_ENTRY', 'DSH_PNPM_ENTRY']) {
    const configured = environment[key]
    if (configured !== undefined && configured !== '') return configured
  }
  const local = join(repoRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(local)) return local
  const npmExec = environment.npm_execpath
  if (npmExec !== undefined && npmExec !== '') {
    const real = realpathSafe(npmExec)
    if (real !== undefined && real.endsWith('.cjs')) return real
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  const shim = firstOutputLine(() => execFileSync(lookup, ['pnpm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: environment }))
  if (shim !== undefined) {
    const real = realpathSafe(shim)
    if (real !== undefined && real.endsWith('.cjs')) return real
    for (const candidate of [
      join(shim, '..', '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(shim, '..', '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('pnpm JavaScript entry not found; set DSH_TEST_PNPM_ENTRY')
}

function defaultRepoRoot() {
  return join(dirnameOfModule(), '..')
}

function dirnameOfModule() {
  // import.meta.dirname is available on Node 20.11+/21.2+ (repo pins >=24).
  return import.meta.dirname
}

function firstOutputLine(run) {
  try {
    const text = run().trim()
    if (text === '') return undefined
    return text.split(/\r?\n/u)[0]
  } catch {
    return undefined
  }
}

function realpathSafe(path) {
  try { return realpathSync(path) } catch { return undefined }
}
