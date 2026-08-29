import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { forkUtilityProcess } from '../src/main/runtime/utility-launcher.ts'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e02c-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
const wrapperPath = fileURLToPath(new URL('../src/main/runtime/wrapper.cjs', import.meta.url))
const probePath = fileURLToPath(new URL('./native-probe.cjs', import.meta.url))
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DSH_HOME: dshHome, NO_COLOR: '1' }
let result = { ok: false, detail: '' }

app.setPath('userData', userData)

async function run() {
  const child = forkUtilityProcess({
    launchId: 'e02c-probe',
    dshHome,
    wrapperPath: probePath,
    cwd: process.cwd(),
    env,
  })
  let stderr = ''
  child.onStderr(chunk => { stderr += chunk.toString('utf8') })
  const nativeProbe = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout: ${stderr.slice(-1000)}`)), 60_000)
    child.onMessage(message => {
      if ((message as { type?: string }).type === 'native-probe') {
        clearTimeout(timer)
        resolve(message as { results: Record<string, unknown> })
      }
    })
    child.onExit(code => {
      clearTimeout(timer)
      reject(new Error(`child exited early (${code}): ${stderr.slice(-1000)}`))
    })
  })
  const results = (nativeProbe as { results: Record<string, unknown> }).results
  const ok = results.nodeSqlite === true
    && results.koffi === true
    && results.nodePty === true
    && typeof results.execPath === 'string'
    && typeof results.nodeVersion === 'string'
  result = { ok, detail: JSON.stringify(results) }
  child.kill()
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    result = { ok: false, detail: String(error) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    console.log('E02C_RESULT', JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  }
})
