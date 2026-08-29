import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const mount = document.getElementById('root')
if (mount === null) throw new Error('about: missing root mount')

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
