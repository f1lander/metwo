import { type Nudge, nudges, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { type NudgeDraft, nudgeActions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { Avatar, Button, timeAgo } from './ui.js'

type Pick = { id: string; login: string }

// Every nudge you could send for these tickets; `due` ones have waited long enough.
export const nudgesFor = (tickets: readonly Ticket[]): Nudge[] => tickets.flatMap((t) => nudges(t))

// The drafts, one DM per reviewer: read, edit, send. Nothing goes out until you press Send.
export function NudgeDialog({ picks, onClose }: { picks: readonly Pick[]; onClose: () => void }) {
  const [drafts, setDrafts] = useState<(NudgeDraft & { edit: string; id: string; sent?: boolean })[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    nudgeActions.draft(picks).then(
      (r) => live && setDrafts(r.drafts.map((d) => ({ ...d, edit: d.text, id: d.slackId ?? '' }))),
      (err: unknown) => {
        failed(err)
        onClose()
      },
    )
    return () => {
      live = false
    }
  }, [picks, onClose])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])
  const set = (login: string, patch: Partial<NudgeDraft & { edit: string; id: string; sent: boolean }>) => setDrafts((ds) => ds?.map((d) => (d.login === login ? { ...d, ...patch } : d)) ?? null)
  const send = async (d: NonNullable<typeof drafts>[number]) => {
    setBusy(d.login)
    try {
      await nudgeActions.send(d.login, d.id.trim(), d.edit, d.items.map((i) => i.id))
      set(d.login, { sent: true })
      notice({ title: `Nudged ${d.name} on Slack`, tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const left = drafts?.filter((d) => !d.sent && d.id.trim()) ?? []
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div role="dialog" aria-label="Nudge reviewers on Slack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex max-h-[80vh] w-full max-w-[640px] flex-col gap-3 overflow-y-auto rounded-xl border border-line-2 bg-panel p-4 text-[13px] shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Nudge on Slack</span>
          <span className="text-xs text-muted">a DM from you, one per reviewer</span>
          <button type="button" aria-label="Close" className="ml-auto text-muted hover:text-fg" onClick={onClose}>
            ✕
          </button>
        </div>
        {!drafts && <span className="animate-pulse text-xs text-muted">Finding them in Slack…</span>}
        {drafts?.length === 0 && <span className="text-xs text-muted">Nothing to nudge here any more.</span>}
        <AnimatePresence initial={false}>
          {drafts?.map((d) => (
            <motion.div key={d.login} layout className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${d.sent ? 'border-[#1f4a31] bg-[#121a15]' : 'border-line-2 bg-bg'}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Avatar login={d.login} size={18} />
                <span className="font-medium text-fg">{d.name}</span>
                <span className="text-muted">@{d.login} · {d.items.length} PR{d.items.length === 1 ? '' : 's'}</span>
                {d.local && <span className={d.offHours ? 'text-warn' : 'text-muted'}>· {d.local} for them{d.offHours ? ', outside work hours' : ''}</span>}
                {d.sent && <span className="ml-auto text-ok">✓ sent</span>}
              </div>
              {!d.sent && (
                <>
                  {!d.slackId && (
                    <label className="flex flex-wrap items-center gap-2 text-xs text-warn">
                      Not found in Slack. Their member ID (profile › ⋯ › Copy member ID):
                      <input value={d.id} onChange={(e) => set(d.login, { id: e.target.value })} placeholder="U01ABCDEF" className="w-36 rounded-md border border-line-2 bg-panel px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent" />
                    </label>
                  )}
                  <textarea aria-label={`message to ${d.name}`} value={d.edit} onChange={(e) => set(d.login, { edit: e.target.value })} rows={Math.min(8, Math.max(3, d.edit.split("\n").length + Math.ceil(d.edit.length / 75)))} className="rounded-md border border-line-2 bg-panel px-2 py-1.5 text-[13px] leading-relaxed text-fg outline-none focus:border-accent" />
                  <div className="flex items-center gap-2">
                    <Button variant="primary" disabled={busy !== null || !d.id.trim() || !d.edit.trim()} onClick={() => void send(d)}>
                      {busy === d.login ? 'Sending…' : 'Send'}
                    </Button>
                    <span className="text-[11px] text-muted">{d.items.map((i) => `#${i.number}`).join(', ')}</span>
                  </div>
                </>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {left.length > 1 && (
          <div className="flex justify-end">
            <Button
              disabled={busy !== null}
              onClick={() =>
                void (async () => {
                  for (const d of left) await send(d)
                })()
              }
            >
              Send all {left.length}
            </Button>
          </div>
        )}
      </motion.div>
    </div>
  )
}

// One reviewer on one ticket: the chip's Nudge, or when you last did.
export function NudgeChip({ ticket: t, login }: { ticket: Ticket; login: string }) {
  const [open, setOpen] = useState<Pick[] | null>(null)
  const n = nudges(t).find((x) => x.login.toLowerCase() === login.toLowerCase())
  const last = t.nudges?.[login.toLowerCase()]?.at
  if (!n && !last) return null
  return (
    <>
      {last && <span className="text-muted">· nudged {timeAgo(last)} ago</span>}
      {n && (
        <button type="button" className="text-accent-fg hover:underline" title={n.kind === 'rereview' ? 'DM them on Slack: you addressed their comments, could they look again' : 'DM them on Slack: could they review it'} onClick={() => setOpen([{ id: t.id, login: n.login }])}>
          Nudge
        </button>
      )}
      {open && <NudgeDialog picks={open} onClose={() => setOpen(null)} />}
    </>
  )
}

// A button for a group of tickets (the In review column): every due nudge, one DM per reviewer.
export function NudgeAll({ tickets, className = '' }: { tickets: readonly Ticket[]; className?: string }) {
  const [open, setOpen] = useState<Pick[] | null>(null)
  const due = nudgesFor(tickets).filter((n) => n.due)
  if (!due.length) return null
  const people = new Set(due.map((n) => n.login.toLowerCase())).size
  return (
    <>
      <button type="button" className={`rounded-full border border-accent/40 px-2 py-px text-[11px] text-accent-fg hover:bg-accent/10 ${className}`} title={`${due.length} PR(s) waiting on ${people} reviewer(s) for a while`} onClick={() => setOpen(due.map((n) => ({ id: n.id, login: n.login })))}>
        Nudge {people}
      </button>
      {open && <NudgeDialog picks={open} onClose={() => setOpen(null)} />}
    </>
  )
}

// Today: who your PRs wait on, and for how long.
export function NudgesToday({ tickets }: { tickets: readonly Ticket[] }) {
  const [open, setOpen] = useState<Pick[] | null>(null)
  const due = nudgesFor(tickets).filter((n) => n.due)
  if (!due.length) return null
  const byLogin = new Map<string, Nudge[]>()
  for (const n of due) byLogin.set(n.login, [...(byLogin.get(n.login) ?? []), n])
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-line bg-panel px-3 py-3 text-xs">
      <div className="flex items-center gap-2 px-1 font-medium text-muted">
        Reviewers to nudge
        <span className="text-dim">{byLogin.size}</span>
        <Button variant="ghost" className="ml-auto" onClick={() => setOpen(due.map((n) => ({ id: n.id, login: n.login })))}>
          Nudge all on Slack…
        </Button>
      </div>
      {[...byLogin.entries()].map(([login, list]) => (
        <div key={login} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-1 hover:bg-raised">
          <Avatar login={login} size={16} />
          <span className="text-fg">{login}</span>
          <span className="min-w-24 flex-1 truncate text-fg-2">
            {list.map((n) => `#${n.number} ${n.kind === 'rereview' ? '(you addressed their comments)' : '(asked to review)'}`).join(' · ')}
          </span>
          <span className="text-muted">waiting {list[0]?.since ? timeAgo(list[0].since) : ''}</span>
          <button type="button" className="text-accent-fg hover:underline" onClick={() => setOpen(list.map((n) => ({ id: n.id, login: n.login })))}>
            Nudge
          </button>
        </div>
      ))}
      {open && <NudgeDialog picks={open} onClose={() => setOpen(null)} />}
    </section>
  )
}
