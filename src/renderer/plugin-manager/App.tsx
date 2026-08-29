import { useCallback, useEffect, useState } from 'react'
import type { PluginEntry, PluginOperationResult } from '../../shared/plugin-manager-api'
import './plugin-manager.css'

type Status = { kind: 'idle' } | { kind: 'working'; message: string } | { kind: 'error'; message: string } | { kind: 'ok'; message: string }

export function App(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [spec, setSpec] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const refresh = useCallback(async () => {
    try {
      setPlugins(await window.insuremoPlugins.list())
    } catch (error) {
      setStatus({ kind: 'error', message: String(error) })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (promise: Promise<PluginOperationResult>, message: string): Promise<void> => {
    setStatus({ kind: 'working', message })
    const result = await promise
    setStatus(result.ok ? { kind: 'ok', message: result.message } : { kind: 'error', message: result.message })
    await refresh()
  }

  return (
    <main className="pm" aria-labelledby="title">
      <header className="pm-header">
        <h1 id="title">Plugin Manager</h1>
        <p className="pm-sub">Install and manage DSH plugins in the web profile. Plugins run with Agent/Host privileges.</p>
      </header>

      <section className="pm-install" aria-label="Install plugin">
        <h2>Install</h2>
        <div className="pm-row">
          <input
            className="pm-input"
            value={spec}
            onChange={event => setSpec(event.target.value)}
            placeholder="npm package, alias@npm:target, or git URL"
            aria-label="Plugin spec"
          />
          <button type="button" onClick={() => void run(window.insuremoPlugins.addSpec(spec), 'Installing…')} disabled={spec.trim() === '' || status.kind === 'working'}>
            Install
          </button>
        </div>
        <div className="pm-row">
          <button type="button" onClick={async () => {
            const picked = await window.insuremoPlugins.pickTgz()
            if (picked !== undefined) {
              await run(window.insuremoPlugins.installCapability(picked.capabilityId), `Installing ${picked.name}…`)
            }
          }} disabled={status.kind === 'working'}>
            Pick .tgz…
          </button>
          <button type="button" onClick={async () => {
            const picked = await window.insuremoPlugins.pickDirectory()
            if (picked !== undefined) {
              await run(window.insuremoPlugins.installCapability(picked.capabilityId), `Installing ${picked.name}…`)
            }
          }} disabled={status.kind === 'working'}>
            Pick directory…
          </button>
          <button type="button" onClick={() => void run(window.insuremoPlugins.rollback(), 'Rolling back…')} disabled={status.kind === 'working'}>
            Rollback last change
          </button>
        </div>
      </section>

      {status.kind !== 'idle' && (
        <p className={`pm-status pm-status-${status.kind}`} role="status">{status.message}</p>
      )}

      <section className="pm-list" aria-label="Installed plugins">
        <h2>Installed</h2>
        {plugins.length === 0 ? (
          <p className="pm-empty">No plugins installed.</p>
        ) : (
          <ul className="pm-items">
            {plugins.map(plugin => (
              <li key={plugin.name} className="pm-item">
                <div className="pm-item-info">
                  <span className="pm-item-name">{plugin.name}</span>
                  <span className="pm-item-version">{plugin.version}</span>
                  {plugin.isWorkbench && <span className="pm-badge pm-badge-system">System</span>}
                  {plugin.isBundle && !plugin.isWorkbench && <span className="pm-badge pm-badge-bundle">Bundle</span>}
                </div>
                <div className="pm-item-actions">
                  <button type="button" onClick={() => void run(window.insuremoPlugins.remove(plugin.name), `Removing ${plugin.name}…`)} disabled={plugin.isWorkbench || status.kind === 'working'}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
