import type { PrSize, Ticket } from '@ticketflow/shared'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { notice } from '../lib/notice.js'
import { Button, ConfirmButton } from './ui.js'

type Wrap = (fn: () => Promise<unknown>) => (e?: React.MouseEvent) => unknown

// Ready for review. Over a size or Greptile limit you set, the daemon says why and the button
// asks before marking it ready anyway.
export function ReadyButton({ ticket: t, busy, wrap, primary = true, className = '' }: { ticket: Ticket; busy: boolean; wrap: Wrap; primary?: boolean; className?: string }) {
  const [held, setHeld] = useState<string | null>(null)
  const ready = wrap(async () => {
    try {
      await actions.ready(t)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.startsWith('Held:')) throw err
      setHeld(msg.replace(/^Held:\s*/, ''))
      notice({ id: t.id, title: 'Not marked ready yet', detail: msg.replace(/^Held:\s*/, ''), tone: 'warn' })
    }
  })
  if (held)
    return <ConfirmButton variant="default" className={className} label="Ready anyway…" confirm="Mark ready anyway" disabled={busy} onConfirm={() => void wrap(() => actions.ready(t, true).then(() => setHeld(null)))()} />
  return (
    <Button variant={primary ? 'primary' : 'default'} className={className} disabled={busy} title="takes the PR out of draft so teammates can review it" onClick={(e) => void ready(e)}>
      Ready for review
    </Button>
  )
}

// "182 lines" on a card; the title has the rest
export function SizeChip({ size }: { size: PrSize }) {
  const big = size.lines > 400
  return (
    <span title={`${size.lines} lines changed in ${size.files} files${size.tests ? `, ${size.tests} in tests` : ''} (lockfiles and snapshots not counted)`} className={`shrink-0 tabular-nums ${big ? 'text-warn' : 'text-dim'}`}>
      {size.lines} lines
    </span>
  )
}
