import { useCallback, useEffect, useState } from 'react'
import type { FailureDiagnostics } from '../../shared/failure-api.ts'
import './failure.css'

type Busy = 'restart' | 'safe' | 'rollback' | 'remove' | null

export function App(): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<FailureDiagnostics | undefined>(undefined)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    setDiagnostics(await window.insuremoFailure.diagnostics())
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const act = async (kind: Exclude<Busy, null>, action: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(kind)
    setNotice('')
    try {
      const result = await action()
      setNotice(`${result.ok ? 'Done' : 'Failed'}: ${result.message}`)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (diagnostics === undefined) {
    return <main className="fx"><p>Loading diagnostics…</p></main>
  }

  const p = diagnostics.profile
  const removableMissing = p.missingModules.find(name => !name.startsWith('@deepseek-ai/'))
  return (
    <main className="fx" aria-labelledby="fx-title">
      <h1 id="fx-title">Harness could not start</h1>
      <p className="fx-sub">
        The local shell is fine — the harness runtime failed to boot
        {diagnostics.mode === 'safe' ? ' (safe mode)' : ''}. Use the recovery actions below; your plugins are not removed automatically.
      </p>

      <section className="fx-card" aria-label="Error">
        <h2>Error</h2>
        <pre className="fx-pre" data-testid="fx-message">{diagnostics.message || diagnostics.phase}</pre>
        {diagnostics.stderrTail !== '' && <pre className="fx-pre fx-dim" data-testid="fx-stderr">{diagnostics.stderrTail}</pre>}
      </section>

      <section className="fx-card" aria-label="Profile state">
        <h2>Profile state</h2>
        <ul className="fx-facts">
          <li>Profile: <code>{p.dir}</code> {p.exists ? '' : <strong>(missing manifest)</strong>}</li>
          <li>Bundles: <code>{p.bundles.join(', ') || '—'}</code></li>
          <li>Dependencies: <code>{Object.keys(p.dependencies).length}</code></li>
          {p.missingModules.length > 0 && (
            <li data-testid="fx-missing">Missing modules: <code>{p.missingModules.join(', ')}</code></li>
          )}
          <li>Lockfile: {p.lockfileSha256 === null ? 'absent' : `sha256 ${p.lockfileSha256.slice(0, 12)}…`}{p.lockfileParses === false && <strong> (unparsable)</strong>}</li>
        </ul>
        {removableMissing !== undefined && (
          <button type="button" disabled={busy !== null} onClick={() => void act('remove', () => window.insuremoFailure.removePlugin(removableMissing))}>
            Remove broken plugin “{removableMissing}”…
          </button>
        )}
      </section>

      <section className="fx-card" aria-label="Recent plugin history">
        <h2>Recent plugin operations</h2>
        {diagnostics.provenanceTail.length === 0 ? (
          <p className="fx-dim">No plugin operations recorded.</p>
        ) : (
          <ul className="fx-facts">
            {diagnostics.provenanceTail.map(record => (
              <li key={record.operationId}>
                <code>{record.operation}</code> {record.resolvedName} {record.resolvedVersion} — <em>{record.outcome}</em>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fx-card" aria-label="Recovery actions">
        <h2>Recovery actions</h2>
        <div className="fx-actions">
          <button type="button" disabled={busy !== null} onClick={() => void act('restart', () => window.insuremoFailure.restart())}>
            {busy === 'restart' ? 'Restarting…' : 'Restart harness'}
          </button>
          <button type="button" disabled={busy !== null || diagnostics.mode === 'safe'} onClick={() => void act('safe', () => window.insuremoFailure.enterSafeMode())}>
            Start safe mode
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void act('rollback', () => window.insuremoFailure.rollback())}>
            Roll back to previous generation…
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void act('rollback', () => window.insuremoFailure.rebuild())}>
            Rebuild from manifest…
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void window.insuremoFailure.openLogs()}>
            Open logs
          </button>
        </div>
        {notice !== '' && <p className="fx-notice" role="status">{notice}</p>}
        <p className="fx-dim">Destructive actions ask for confirmation before anything is changed.</p>
      </section>

      {diagnostics.logTail !== '' && (
        <section className="fx-card" aria-label="Harness log tail">
          <h2>Harness log (tail)</h2>
          <pre className="fx-pre fx-dim">{diagnostics.logTail}</pre>
        </section>
      )}
    </main>
  )
}
