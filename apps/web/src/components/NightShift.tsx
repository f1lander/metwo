import type { NightShiftState, SlackMention } from '@ticketflow/shared'
import { useState } from 'react'
import { nightActions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { desktop } from '../lib/tauri.js'
import { Mention } from './Slack.js'
import { Button } from './ui.js'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const WHY = { schedule: 'by your schedule', manual: 'by you', slack: 'by your Slack status' } as const
const RANK = { urgent: 0, ignored: 1, decision: 1, action: 1, fact: 2, outside: 3, info: 3 } as const

// The ids of the messages in the handoff you have not closed yet: Today shows them here, not twice.
export function handoffIds(night: NightShiftState | undefined): ReadonlySet<string> {
  const h = night?.handoff
  return new Set(h && !h.seen && !night?.active ? h.messages : [])
}

// Night Shift on Today: while it runs, what it has read; after, the morning handoff.
export function NightShiftCard({ night, mentions, slack }: { night: NightShiftState | undefined; mentions: readonly SlackMention[]; slack: boolean }) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  if (night?.active) {
    const since = night.since ?? ''
    const read = mentions.filter((m) => m.at >= since && m.night)
    const need = read.filter((m) => m.night?.kind === 'decision' || m.night?.kind === 'action' || m.night?.kind === 'urgent').length
    return (
      <section className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-xs">
        <span aria-hidden="true" className="text-base">🌙</span>
        <span className="font-semibold text-fg">Night Shift is on</span>
        <span className="text-fg-2">
          since {clock(since)} {night.reason ? WHY[night.reason] : ''} · {read.length} message{read.length === 1 ? '' : 's'} read{need ? ` · ${need} need you` : ''}
        </span>
        <Button className="ml-auto" disabled={busy} onClick={() => void run(() => nightActions.set('off'))}>
          I'm back
        </Button>
        <TryIt />
      </section>
    )
  }

  const h = night?.handoff
  if (!h || h.seen) {
    if (!slack) return null
    return (
      <div className="-mt-2 flex justify-end">
        <button type="button" disabled={busy} className="text-[11px] text-muted hover:text-fg disabled:opacity-50" onClick={() => void run(() => nightActions.set('on'))}>
          🌙 Going offline? Start Night Shift
        </button>
      </div>
    )
  }

  const byId = new Map(mentions.map((m) => [m.id, m]))
  const msgs = h.messages
    .map((id) => byId.get(id))
    .filter((m): m is SlackMention => Boolean(m))
    .sort((a, b) => RANK[a.night?.kind ?? 'info'] - RANK[b.night?.kind ?? 'info'] || a.at.localeCompare(b.at))
  const need = msgs.filter((m) => m.night?.kind === 'decision' || m.night?.kind === 'action' || m.night?.kind === 'urgent').length
  const answered = msgs.filter((m) => m.night?.posted && m.night.kind === 'fact').length
  const summary = [
    `${msgs.length} message${msgs.length === 1 ? '' : 's'}`,
    need ? `${need} need you` : '',
    answered ? `${answered} answered by mevo` : '',
    h.events.length ? `${h.events.length} PR update${h.events.length === 1 ? '' : 's'}` : '',
    h.nudges ? `${h.nudges} reviewer${h.nudges === 1 ? '' : 's'} to nudge` : '',
  ].filter(Boolean)
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span aria-hidden="true">☀️</span>
        <span className="font-medium text-fg">Morning handoff</span>
        <span className="text-muted">
          {clock(h.from)} to {clock(h.to)}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-2 max-md:order-last max-md:basis-full max-md:whitespace-normal">{summary.join(' · ')}</span>
        <Button variant="ghost" className="max-md:ml-auto" disabled={busy} onClick={() => void run(() => nightActions.seen())}>
          Done
        </Button>
      </div>
      {msgs.map((m) => (
        <Mention key={m.id} mention={m} />
      ))}
      {h.events.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1 pt-1">
          <span className="text-[11px] font-medium text-muted">On your PRs</span>
          {h.events.map((e, i) => (
            <div key={`${e.id}-${e.at}-${i}`} className="flex items-baseline gap-2">
              <span className="w-11 shrink-0 text-dim">{clock(e.at)}</span>
              <span className="shrink-0 text-muted">{e.id}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{e.title}</span>
              {e.url && (
                <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => void desktop.open(e.url!)}>
                  PR
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!msgs.length && !h.events.length && <p className="px-1 text-dim">A quiet night: nothing came in.</p>}
    </section>
  )
}

const SAMPLES = [
  { label: 'a question it can answer', text: 'hey, is CI green on your registration error PR? want to include it in tonight\'s release' },
  { label: 'one that needs you', text: 'can you pick up the renew modal spacing bug tomorrow morning?' },
  { label: 'something urgent', text: 'prod registration is broken for everyone, can you look asap?' },
]

// Night Shift without waking a teammate: a made-up message as if someone wrote to you. It is
// read and drafted like a real one and lands in your DM with the bot, so Post as mevo (or
// facts mode) shows the bot can really post. Your own Slack messages are ignored on purpose.
function TryIt() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (t: string) => {
    if (!t.trim()) return
    setBusy(true)
    try {
      const { mention } = await nightActions.test(t.trim())
      setText('')
      notice({ title: mention.night ? `Read as: ${mention.night.kind}` : 'Sent', detail: 'It is in Slack mentions below, with what the bot would answer.', tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-accent/20 pt-2">
      <span className="text-muted">Try it with</span>
      {SAMPLES.map((s) => (
        <button key={s.label} type="button" disabled={busy} title={s.text} onClick={() => void send(s.text)} className="rounded-full border border-line-2 px-2 py-0.5 text-fg-2 hover:border-accent disabled:opacity-50">
          {s.label}
        </button>
      ))}
      <form className="flex min-w-48 flex-1 items-center gap-1.5" onSubmit={(e) => (e.preventDefault(), void send(text))}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="or write one, as a teammate would" aria-label="test message" className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent max-md:text-[16px]" />
        <Button disabled={busy || !text.trim()} type="submit">
          {busy ? 'Reading…' : 'Send'}
        </Button>
      </form>
    </div>
  )
}
