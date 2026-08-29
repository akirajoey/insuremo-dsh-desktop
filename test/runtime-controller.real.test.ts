import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { RuntimeController } from '../src/main/runtime/controller'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e02-ctrl-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
const wrapperPath = fileURLToPath(new URL('../src/main/runtime/wrapper.cjs', import.meta.url))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('runtime controller real spike', () => {
  it('boots the rc7 web profile, serves HTTP, and shuts down cleanly', async () => {
    const controller = new RuntimeController({
      launchId: 'e02-test-1',
      dshHome,
      wrapperPath,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      userData,
      startTimeoutMs: 40_000,
      readySettleMs: 300,
      shutdownGraceMs: 10_000,
    })
    try {
      await controller.start()
      const ready = await controller.waitUntilReady()
      expect(ready.phase).toBe('ready')
      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const response = await fetch(ready.url ?? '')
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('DeepSeek Harness')
      const outcome = await controller.requestShutdown(10_000)
      expect(outcome.kind).toBe('exited')
      expect(existsSync(join(userData, 'desktop-state', 'runtime-owner.json'))).toBe(false)
    } finally {
      await controller.cleanup()
    }
  }, 120_000)
})
