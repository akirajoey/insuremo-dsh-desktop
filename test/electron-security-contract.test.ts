import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (file: string) => readFile(resolve(root, file), 'utf8')

describe('E01 Electron security contract', () => {
  it('uses a narrow contextBridge API', async () => {
    const source = await read('src/preload/about.ts')
    expect(source).toContain("contextBridge.exposeInMainWorld('insuremoDesktop', api)")
    expect(source).toContain("ipcRenderer.invoke('app:version')")
    expect(source).not.toContain('exposeInMainWorld(\'ipcRenderer\'')
    expect(source).not.toContain('ipcRenderer.on(')
  })

  it('hardens the About BrowserWindow', async () => {
    const source = await read('src/main/windows/about-window.ts')
    for (const setting of [
      'nodeIntegration: false',
      'contextIsolation: true',
      'sandbox: true',
      'webSecurity: true',
      'webviewTag: false',
    ]) expect(source).toContain(setting)
    expect(source).toContain('setWindowOpenHandler')
    expect(source).toContain('will-attach-webview')
    expect(source).toContain('will-navigate')
    expect(source).toContain("preload: join(__dirname, '../preload/about.cjs')")
    expect(source).toContain("join(__dirname, '../renderer/index.html')")
    expect(source).not.toContain("preload: join(__dirname, '../preload/about.mjs')")
    const html = await read('src/renderer/index.html')
    expect(html).toContain('./about/main.tsx')
  })

  it('authorizes the version handler instead of trusting the channel name', async () => {
    const source = await read('src/main/index.ts')
    expect(source).toContain('authorizeIpc({')
    expect(source).toContain('event.senderFrame')
    expect(source).toContain("throw new Error('forbidden')")
  })
})
