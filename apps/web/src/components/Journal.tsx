import type { JournalEntry, JournalKind, Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { actions, mediaUrl } from '../lib/api.js'
import { desktop } from '../lib/tauri.js'
import { Markdown } from './Markdown.js'
import { Button, Mono, Section } from './ui.js'
import { failed } from '../lib/notice.js'

const KIND: Record<JournalKind, { readonly label: string; readonly dot: string }> = {
  run: { label: 'Lane', dot: 'bg-accent-fg' },
  review: { label: 'Review', dot: 'bg-accent' },
  question: { label: 'Question', dot: 'bg-warn' },
  answer: { label: 'You', dot: 'bg-fg-2' },
  ready: { label: 'Ready', dot: 'bg-warn' },
  no_change: { label: 'No change', dot: 'bg-warn' },
  pr: { label: 'PR', dot: 'bg-ok-dot' },
  failure: { label: 'Failure', dot: 'bg-bad' },
  linear: { label: 'Linear', dot: 'bg-[#5e6ad2]' },
  comment: { label: 'Comment', dot: 'bg-accent' },
  note: { label: 'Note', dot: 'bg-fg' },
  ask: { label: 'Chat', dot: 'bg-fg-2' },
}

// Everything done on the ticket, newest first, plus a box for your own notes.
export function Journal({ ticket }: { ticket: Ticket }) {
  const entries = [...(ticket.journal ?? [])].reverse()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const totals = (ticket.journal ?? []).reduce(
    (acc, e) => ({
      cost: acc.cost + (typeof e.meta?.cost === 'number' ? e.meta.cost : 0),
      minutes: acc.minutes + (typeof e.meta?.minutes === 'number' ? e.meta.minutes : 0),
      runs: acc.runs + (e.kind === 'run' ? 1 : 0),
    }),
    { cost: 0, minutes: 0, runs: 0 },
  )

  const save = async () => {
    if (!note.trim()) return
    setBusy(true)
    try {
      await actions.note(ticket, note)
      setNote('')
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={`Journal · ${entries.length}`}
      right={
        totals.runs > 0 ? (
          <Mono className="text-dim">
            {totals.runs} run{totals.runs === 1 ? '' : 's'} · {Math.round(totals.minutes)} min{totals.cost ? ` · $${totals.cost.toFixed(2)}` : ''}
          </Mono>
        ) : undefined
      }
    >
      {ticket.archived && <p className="text-xs text-dim">Closed a while ago: the entries' texts, PR comments and checks are kept in data/archive/{ticket.id}.json.</p>}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label htmlFor={`note-${ticket.id}`} className="sr-only">
          Add a note
        </label>
        <input
          id={`note-${ticket.id}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note to this ticket's journal"
          className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-3 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent max-md:min-h-10 max-md:text-[16px]"
        />
        <Button type="submit" disabled={busy || !note.trim()}>
          Add
        </Button>
      </form>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-xs text-dim">Nothing yet. Each lane turn, hand-off, Linear move and note lands here.</div>
      ) : (
        <ol className="relative flex flex-col gap-1 pl-4 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-line">
          <AnimatePresence initial={false}>
            {entries.map((e) => (
              <Entry key={e.at + e.title} entry={e} ticketId={ticket.id} />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Section>
  )
}

function Entry({ entry: e, ticketId }: { entry: JournalEntry; ticketId: string }) {
  const [open, setOpen] = useState(e.kind === 'note' || e.kind === 'question')
  const kind = KIND[e.kind]
  const meta = Object.entries(e.meta ?? {}).filter(([k]) => k !== 'url' && k !== 'images')
  const images = typeof e.meta?.images === 'string' ? e.meta.images.split(', ').filter(Boolean) : []
  const url = typeof e.meta?.url === 'string' ? e.meta.url : null
  return (
    <motion.li layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="relative">
      <span className={`absolute top-[7px] -left-4 size-[7px] rounded-full ring-2 ring-bg ${kind.dot}`} aria-hidden="true" />
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!e.body} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1 py-1 text-left hover:bg-raised disabled:cursor-default disabled:hover:bg-transparent">
        <span className="text-[11px] text-dim">{new Date(e.at).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <span className="text-[11px] font-medium text-muted">{kind.label}</span>
        <span className="text-xs text-fg">{e.title}</span>
        {meta.map(([k, v]) => (
          <Mono key={k} className="rounded bg-raised px-1.5 text-dim">
            {k === 'cost' ? `$${v}` : k === 'minutes' ? `${v} min` : String(v)}
          </Mono>
        ))}
        {e.body && <span className="ml-auto text-[11px] text-dim">{open ? '−' : '+'}</span>}
      </button>
      {url && (
        <button type="button" onClick={() => void desktop.open(url)} className="ml-1 text-[11px] text-accent-fg hover:underline">
          open
        </button>
      )}
      {images.length > 0 && (
        <div className="mx-1 mb-1.5 flex flex-wrap gap-1.5">
          {images.map((name) => (
            <button key={name} type="button" onClick={() => void desktop.open(mediaUrl(ticketId, name))}>
              <img src={mediaUrl(ticketId, name)} alt={name} className="h-16 rounded border border-line object-cover" />
            </button>
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && e.body && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mx-1 mb-2 max-h-72 overflow-auto rounded-md border border-line bg-sunk px-3 py-2 text-xs leading-relaxed text-fg-2"
          >
            <Markdown source={e.body} ticketId={ticketId} className="md-sm" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  )
}
