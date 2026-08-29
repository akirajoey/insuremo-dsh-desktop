import { createHash } from 'node:crypto'
import type { PluginSpec } from './contracts.ts'

/** npm package-name grammar: scoped or bare, letters/digits/-/./_ . */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

const GIT_URL_RE = /^(?:https:\/\/[^\s]+|git\+https:\/\/[^\s]+|git@[^:\s]+:[^\s]+)(?:#[0-9A-Za-z._-]+)?$/u

/** Parse a plugin install spec into a typed PluginSpec. Throws on invalid input. */
export function parsePluginSpec(input: string): PluginSpec {
  if (input === '') throw new Error('plugin: empty spec')
  if (input.includes('\0')) throw new Error('plugin: NUL in spec')
  if (input.startsWith('-')) throw new Error('plugin: spec must not start with -')
  if (input.includes('--')) throw new Error('plugin: options are not allowed')

  const aliasMatch = /^(?<alias>@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*)@npm:(?<target>@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*)(?:@(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?))?$/iu.exec(input)
  if (aliasMatch?.groups !== undefined) {
    const alias = aliasMatch.groups.alias ?? ''
    const target = aliasMatch.groups.target ?? ''
    const version = aliasMatch.groups.version
    if (!PACKAGE_NAME_RE.test(alias)) throw new Error(`plugin: invalid alias ${JSON.stringify(alias)}`)
    if (!PACKAGE_NAME_RE.test(target)) throw new Error(`plugin: invalid alias target ${JSON.stringify(target)}`)
    if (version !== undefined && !VERSION_RE.test(version)) throw new Error(`plugin: invalid version ${JSON.stringify(version)}`)
    return { kind: 'alias', alias, target, version }
  }

  if (GIT_URL_RE.test(input)) return { kind: 'git', url: input }

  const npmMatch = /^(?<package>@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*)(?:@(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?))?$/iu.exec(input)
  if (npmMatch?.groups !== undefined) {
    const packageName = npmMatch.groups.package ?? ''
    const version = npmMatch.groups.version
    if (!PACKAGE_NAME_RE.test(packageName)) throw new Error(`plugin: invalid package name ${JSON.stringify(packageName)}`)
    if (version !== undefined && !VERSION_RE.test(version)) throw new Error(`plugin: invalid version ${JSON.stringify(version)}`)
    return { kind: 'npm', package: packageName, version }
  }

  throw new Error(`plugin: unsupported spec ${JSON.stringify(input)}`)
}

export function specToPnpmArg(spec: PluginSpec): string {
  switch (spec.kind) {
    case 'npm':
      return spec.version !== undefined ? `${spec.package}@${spec.version}` : spec.package
    case 'alias':
      return spec.version !== undefined
        ? `${spec.alias}@npm:${spec.target}@${spec.version}`
        : `${spec.alias}@npm:${spec.target}`
    case 'git':
      return spec.url
    case 'tgz':
      return `file:${spec.capabilityId}`
    case 'local':
      return `file:${spec.capabilityId}`
  }
}

export function specDigest(spec: PluginSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}
