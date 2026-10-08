/**
 * Safe-home runtime graph contract (TASK-139).
 *
 * Safe mode boots a core-only home that pnpm resolves from the registry, so
 * every package whose range is floating there can drift away from the frozen
 * graph the bundled Full runtime was built and verified with. The observed
 * release blocker was exactly that: `@deepseek-ai/cordis-plugin-hmr` floated
 * from `^1.0.16` to `1.0.19`, whose `hmr.registerConfig` is gone, so
 * `@deepseek-ai/dsh-app-boot@0.1.0-rc.7` aborted the safe boot with
 * `TypeError: hmr.registerConfig is not a function`.
 *
 * `config/runtime-pins.json` therefore records the exact non-DSH Cordis
 * versions (its `nonDshCordisPattern` selects them, its `nonDshCordis` map
 * freezes them, and `scripts/audit-runtime-pins.mjs` fails when the map drifts
 * from the frozen `pnpm-lock.yaml`). This module renders those pins into the
 * safe profile's pnpm overrides and fingerprints the resolved graph so a safe
 * home built from an older graph is re-installed instead of silently kept.
 */
export const SAFE_GRAPH_SCHEMA_VERSION = 1

/** Marker written inside the safe web profile after a successful install. */
export const SAFE_GRAPH_FILE = 'safe-graph.json'

export interface SafeRuntimePins {
  /** Exact `@deepseek-ai/dsh*` runtime version. */
  version: string
  /** DSH runtime packages that must resolve to `version`. */
  packages: readonly string[]
  /** Exact non-DSH Cordis versions from the frozen bundled baseline. */
  nonDshCordis?: Readonly<Record<string, string>>
}

export const DEFAULT_SAFE_RUNTIME_PINS: SafeRuntimePins = {
  version: '0.1.0-rc.7',
  packages: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  nonDshCordis: {},
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/**
 * Exact pnpm overrides for the safe home: the pinned DSH packages plus every
 * frozen non-DSH Cordis package. A non-exact Cordis value is refused rather
 * than emitted, so a floating range can never reach the install.
 */
export function safeRuntimeOverrides(pins: SafeRuntimePins = DEFAULT_SAFE_RUNTIME_PINS): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const name of pins.packages) overrides[name] = pins.version
  for (const [name, version] of Object.entries(pins.nonDshCordis ?? {})) {
    if (!EXACT_VERSION.test(version)) throw new Error(`non-DSH Cordis pin is not exact: ${name}@${version}`)
    overrides[name] = version
  }
  return overrides
}

export interface SafeGraphDescriptor {
  schemaVersion: number
  version: string
  /** Sorted exact overrides; the fingerprint compared against a built safe home. */
  overrides: Record<string, string>
}

export function safeGraphDescriptor(pins: SafeRuntimePins = DEFAULT_SAFE_RUNTIME_PINS): SafeGraphDescriptor {
  const overrides = safeRuntimeOverrides(pins)
  return {
    schemaVersion: SAFE_GRAPH_SCHEMA_VERSION,
    version: pins.version,
    overrides: Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))),
  }
}

/** True only when a previously recorded safe-home graph equals the expected one. */
export function safeGraphMatches(recorded: unknown, expected: SafeGraphDescriptor): boolean {  if (recorded === null || typeof recorded !== 'object') return false
  const value = recorded as Partial<SafeGraphDescriptor>
  if (value.schemaVersion !== expected.schemaVersion || value.version !== expected.version) return false
  const overrides = value.overrides
  if (overrides === null || typeof overrides !== 'object') return false
  const expectedNames = Object.keys(expected.overrides)
  const recordedNames = Object.keys(overrides).sort((left, right) => left.localeCompare(right))
  if (recordedNames.length !== expectedNames.length) return false
  return expectedNames.every((name, index) => recordedNames[index] === name && overrides[name] === expected.overrides[name])
}

/**
 * True when a safe home must be (re-)installed: it has no readable graph
 * marker, or the marker describes a different graph than the frozen baseline.
 * A safe home carrying the pre-TASK-139 floating Cordis graph is therefore
 * repaired instead of silently reused.
 */
export function safeGraphStale(recorded: unknown, expected: SafeGraphDescriptor): boolean {
  return !safeGraphMatches(recorded, expected)
}

/** The safe profile workspace file, with every frozen pin rendered as an override. */
export function renderSafeWorkspaceYaml(pins: SafeRuntimePins = DEFAULT_SAFE_RUNTIME_PINS): string {
  const overrides = Object.entries(safeRuntimeOverrides(pins))
    .map(([name, version]) => `  '${name}': ${version}`)
    .join('\n')
  return `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  electron: true\n  esbuild: true\n  koffi: true\n  node-pty: true\n  protobufjs: true\noverrides:\n${overrides}\n`
}
