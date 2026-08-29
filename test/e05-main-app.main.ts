import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme } from 'electron'

const tmp = mkdtempSync(join(tmpdir(), 'insuremo-dsh-e05-main-'))
app.setPath('appData', tmp)
app.on('window-all-closed', () => { /* index owns true-quit; keep probe alive */ })
let result = { ok: false, detail: '' }

function menuLabels(menu: Electron.Menu): string[] {
  const labels: string[] = []
  for (const item of menu.items) {
    if (item.label !== '') labels.push(item.label)
    if (item.submenu !== undefined && item.submenu !== null) labels.push(...menuLabels(item.submenu))
  }
  return labels
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('probe timeout')
}

const hardTimeout = setTimeout(() => {
  result = { ok: false, detail: 'main app probe timeout' }
  writeFileSync('/tmp/e05-main-result.json', JSON.stringify(result))
  app.exit(1)
}, 120_000)

app.whenReady().then(async () => {
  try {
    await import('../src/main/index.ts')
    const menu = await waitFor(() => Menu.getApplicationMenu() ?? undefined, 10_000)
    const labels = menuLabels(menu)
    for (const required of ['New Window', 'Restart Harness', 'Manage Plugins…', 'Safe Mode', 'Logs', 'About']) {
      if (!labels.includes(required)) throw new Error(`menu item missing: ${required}`)
    }
    if (nativeTheme.themeSource !== 'system') throw new Error(`theme source: ${nativeTheme.themeSource}`)
    const window = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('http://127.0.0.1:')), 90_000)
    const safeArg = process.argv.includes('--safe-mode')
    const expectedTitle = safeArg ? 'InsureMO DSH Desktop (Safe Mode)' : 'InsureMO DSH Desktop'
    if (window.getTitle() !== expectedTitle) throw new Error(`shell title: ${window.getTitle()}`)
    const logName = safeArg ? 'harness-safe.log' : 'harness.log'
    if (!existsSync(join(tmp, 'insuremo-dsh-desktop-dev', 'logs', logName))) throw new Error('harness log was not created')
    if (safeArg) {
      const safeManifestPath = join(tmp, 'insuremo-dsh-desktop-dev', 'safe-runtime/harness/profiles/web/package.json')
      if (!existsSync(safeManifestPath)) throw new Error('safe manifest was not created')
      const safeManifest = JSON.parse(readFileSync(safeManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
      if (safeManifest.dependencies?.['@icomposer/workbench'] !== undefined) throw new Error('safe manifest contains Workbench')
    }
    result = { ok: true, detail: JSON.stringify({ mode: safeArg ? 'safe' : 'normal', menu: labels, theme: nativeTheme.themeSource, harnessUrl: window.webContents.getURL(), title: window.getTitle(), log: logName }) }
    writeFileSync('/tmp/e05-main-result.json', JSON.stringify(result))
    // Exercise the actual before-quit cleanup path (not app.exit directly).
    app.quit()
  } catch (error) {
    result = { ok: false, detail: String(error) }
    writeFileSync('/tmp/e05-main-result.json', JSON.stringify(result))
    app.exit(1)
  }
})

process.on('exit', () => {
  clearTimeout(hardTimeout)
  rmSync(tmp, { recursive: true, force: true })
  console.log('E05_MAIN_RESULT', JSON.stringify(result))
})
