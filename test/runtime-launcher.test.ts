import { describe, expect, it } from 'vitest'
import { parseHandshake, RuntimeLauncher } from '../src/main/runtime/launcher'

describe('runtime handshake parsing', () => {
  it('accepts a valid handshake', () => {
    const handshake = parseHandshake({
      type: 'handshake',
      requestId: 'launch-1',
      handshake: {
        launchId: 'launch-1',
        pid: 1234,
        startTime: 1000,
        exec: '/node',
        cwd: '/tmp',
        port: 43210,
      },
    })
    expect(handshake?.launchId).toBe('launch-1')
    expect(handshake?.port).toBe(43210)
  })

  it('rejects malformed handshakes', () => {
    expect(parseHandshake({ type: 'other' })).toBeUndefined()
    expect(parseHandshake({ type: 'handshake', handshake: { launchId: 'x' } })).toBeUndefined()
    expect(parseHandshake({ type: 'handshake', handshake: { launchId: 1, pid: 1, startTime: 1, exec: 'e', cwd: 'c', port: 1 } })).toBeUndefined()
  })
})

describe('runtime environment building', () => {
  it('sets DSH_HOME and NO_COLOR, drops ELECTRON_RUN_AS_NODE', () => {
    const env = RuntimeLauncher.buildEnvironment({
      launchId: 'l',
      dshHome: '/home',
      wrapperPath: '/w',
      env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', FOO: 'bar' },
    })
    expect(env.DSH_HOME).toBe('/home')
    expect(env.NO_COLOR).toBe('1')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.FOO).toBe('bar')
  })

  it('sanitizes undefined values', () => {
    const clean = RuntimeLauncher.sanitizeEnvironment({ A: '1', B: undefined as unknown as string })
    expect(clean).toEqual({ A: '1' })
  })

  it('sets Electron run-as-Node only for an explicit experiment opt-in', () => {
    const normal = RuntimeLauncher.buildEnvironment({ launchId: 'normal', dshHome: '/home', wrapperPath: '/w', env: { ELECTRON_RUN_AS_NODE: '1' } })
    const experimental = RuntimeLauncher.buildEnvironment({ launchId: 'experiment', dshHome: '/home', wrapperPath: '/w', env: {}, runAsNode: true })
    expect(normal.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(experimental.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
