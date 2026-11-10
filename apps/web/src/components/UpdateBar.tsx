import type { Health } from '@ticketflow/shared'
import { useEffect, useRef, useState } from 'react'
import { controls } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { desktop, isDesktop } from '../lib/tauri.js'
import { ConfirmButton } from './ui.js'

// mevo running older code than what is on disk, or this window showing an older build of the app.
export function UpdateBar({ health }: { health: Health | null }) {
  const code = health?.code
  const firstWeb = useRef<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (code && firstWeb.current === undefined) firstWeb.current = code.web
  }, [code])
  const webStale = !import.meta.env.DEV && code?.web != null && firstWeb.current != null && code.web !== firstWeb.current
  if (!code?.stale && !webStale) return null
  const lanes = health?.lanes.active.length ?? 0
  const restart = async () => {
    setBusy(true)
    try {
      if (code?.supervised) await controls.restartDaemon()
      else if (isDesktop) await desktop.restart()
      else throw new Error('Restart the daemon where it runs (Ctrl-C, then pnpm daemon).')
      notice({ title: 'Restarting mevo on the new code…', tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-warn/10 px-4 py-1.5 text-xs text-fg-2">
      {code?.stale ? (
        <>
          <span className="text-warn">♻︎ mevo has new code it hasn't loaded</span>
          <span className="min-w-0 truncate text-muted" title={code.files.join('\n')}>
            {code.changed} file{code.changed === 1 ? '' : 's'} changed
            {code.supervised ? (lanes ? ` · it restarts by itself when ${lanes === 1 ? 'the lane finishes' : `the ${lanes} lanes finish`}` : ' · restarting in a moment') : isDesktop ? ' · restart to load it' : ' · started from a terminal: restart it there'}
          </span>
          {(code.supervised || isDesktop) && (
            <span className="ml-auto">
              {lanes ? (
                <ConfirmButton label="Restart now" confirm={`Park ${lanes} running lane${lanes === 1 ? '' : 's'} and restart`} disabled={busy} onConfirm={() => void restart()} />
              ) : (
                <button type="button" className="text-accent-fg hover:underline disabled:opacity-50" disabled={busy} onClick={() => void restart()}>
                  Restart now
                </button>
              )}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-warn">♻︎ The app was rebuilt</span>
          <span className="text-muted">this window shows the old one</span>
          <button type="button" className="ml-auto text-accent-fg hover:underline" onClick={() => location.reload()}>
            Reload
          </button>
        </>
      )}
    </div>
  )
}
