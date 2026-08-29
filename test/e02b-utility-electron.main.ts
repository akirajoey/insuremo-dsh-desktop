import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { parseHandshake } from '../src/main/runtime/launcher.ts'
import { forkUtilityProcess } from '../src/main/runtime/utility-launcher.ts'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e02b-'))
const userData = join(tmp, 'userData')
const dshHome = join(tmp, 'harness')
const wrapperPath = fileURLToPath(new URL('../src/main/runtime/wrapper.cjs', import.meta.url))
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DSH_HOME: dshHome, NO_COLOR: '1' }
let result = { ok: false, detail: '' }

app.setPath('userData', userData)

async function run() {
  const child = forkUtilityProcess({
    launchId: 'e02b-test',
    dshHome,
    wrapperPath,
    cwd: process.cwd(),
    env,
  })
  let stderr = ''
  child.onStderr(chunk => { stderr += chunk.toString('utf8') })
  const handshake = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`handshake timeout: ${stderr.slice(-2500)}`)), 60_000)
    child.onMessage(message => {
      const parsed = parseHandshake(message)
      if (parsed !== undefined) {
        clearTimeout(timer)
        resolve(parsed)
      }
    })
    child.onExit(code => {
      clearTimeout(timer)
      reject(new Error(`child exited early (${code}): ${stderr.slice(-2500)}`))
    })
  })
  const url = `http://127.0.0.1:${(handshake as { port: number }).port}`
  const response = await fetch(url)
  const body = await response.text()
  if (!body.includes('DeepSeek Harness')) throw new Error('unexpected page body')

  const window = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  let navigationDenied = false
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== url) {
      event.preventDefault()
      navigationDenied = true
    }
  })
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    navigationDenied = targetUrl !== url
    return { action: 'deny' }
  })
  await window.loadURL(url)
  const title = await window.webContents.executeJavaScript('document.title')
  if (title !== 'DeepSeek Harness') throw new Error(`unexpected title ${title}`)

  child.post({ type: 'shutdown', requestId: 'e02b-shutdown' })
  const accepted = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000)
    child.onMessage(message => {
      if ((message as { type?: string }).type === 'accepted') {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  if (!accepted) throw new Error('shutdown not accepted')
  const exited = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 15_000)
    child.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!exited) throw new Error('child did not exit after shutdown')

  result = { ok: true, detail: JSON.stringify({ title, navigationDenied, exited }) }
  window.destroy()
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    result = { ok: false, detail: String(error) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    console.log('E02B_RESULT', JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  }
})
