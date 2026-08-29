import { useEffect, useState } from 'react'
import './about.css'

export function App(): JSX.Element {
  const [version, setVersion] = useState<string>('loading')
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void window.insuremoDesktop.app.version()
      .then(setVersion)
      .catch(() => setError('Unable to read the desktop version.'))
  }, [])

  return (
    <main className="about" aria-labelledby="title">
      <div className="mark" aria-hidden="true">IMO</div>
      <p className="eyebrow">InsureMO</p>
      <h1 id="title">DSH Desktop</h1>
      <p className="summary">A secure desktop shell for the InsureMO developer workspace.</p>
      <p className="version" aria-live="polite">
        {error ?? `Version ${version}`}
      </p>
      <p className="boundary">E00/E01 foundation · Harness runtime integration is gated.</p>
    </main>
  )
}
