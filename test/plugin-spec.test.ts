import { describe, expect, it } from 'vitest'
import { parsePluginSpec, specToPnpmArg, specDigest } from '../src/main/plugins/spec-parser'

describe('plugin spec parser', () => {
  it('parses npm specs', () => {
    expect(parsePluginSpec('lodash')).toEqual({ kind: 'npm', package: 'lodash' })
    expect(parsePluginSpec('@scope/plugin@1.2.3')).toEqual({ kind: 'npm', package: '@scope/plugin', version: '1.2.3' })
  })

  it('parses alias specs strictly', () => {
    expect(parsePluginSpec('alias@npm:@scope/target@1.2.3')).toEqual({ kind: 'alias', alias: 'alias', target: '@scope/target', version: '1.2.3' })
    expect(parsePluginSpec('alias@npm:target')).toEqual({ kind: 'alias', alias: 'alias', target: 'target' })
    expect(() => parsePluginSpec('alias@npm:@scope/target@1.2.3@extra')).toThrow()
    expect(() => parsePluginSpec('bad alias@npm:target')).toThrow()
  })

  it('parses git URLs from an allowlist', () => {
    expect(parsePluginSpec('https://github.com/x/y.git')).toEqual({ kind: 'git', url: 'https://github.com/x/y.git' })
    expect(parsePluginSpec('git+https://github.com/x/y.git#main')).toEqual({ kind: 'git', url: 'git+https://github.com/x/y.git#main' })
    expect(() => parsePluginSpec('ssh://x')).toThrow()
  })

  it('rejects unsafe specs', () => {
    expect(() => parsePluginSpec('')).toThrow()
    expect(() => parsePluginSpec('a\0b')).toThrow()
    expect(() => parsePluginSpec('--config')).toThrow()
    expect(() => parsePluginSpec('-x')).toThrow()
  })

  it('serializes to pnpm args', () => {
    expect(specToPnpmArg({ kind: 'npm', package: 'lodash' })).toBe('lodash')
    expect(specToPnpmArg({ kind: 'npm', package: '@s/p', version: '1.0.0' })).toBe('@s/p@1.0.0')
    expect(specToPnpmArg({ kind: 'alias', alias: 'a', target: '@s/t', version: '1.0.0' })).toBe('a@npm:@s/t@1.0.0')
    expect(specToPnpmArg({ kind: 'tgz', capabilityId: '/x.tgz' })).toBe('file:/x.tgz')
  })

  it('computes stable digests', () => {
    const a = specDigest({ kind: 'npm', package: 'lodash' })
    const b = specDigest({ kind: 'npm', package: 'lodash' })
    const c = specDigest({ kind: 'npm', package: 'other' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
