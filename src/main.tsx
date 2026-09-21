import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { restoreInterruptedJob } from './utils/jobRestore'

// Was a job still cutting when this browser last went away? Asked once, here,
// rather than from an effect: the answer comes from storage and from the
// account, and it arrives as a resume point on the machine state that
// `JobRestoreModal` is already watching. Deliberately not awaited — the app
// must not wait on the network to paint.
void restoreInterruptedJob()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
