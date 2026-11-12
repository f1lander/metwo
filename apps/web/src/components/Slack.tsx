import type { SlackMention } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { nightActions, slackActions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { desktop } from '../lib/tauri.js'
import { Button, ConfirmButton, Pill, timeAgo } from './ui.js'
import { MentionRequest } from './Requests.js'

const KIND: Record<NonNullable<SlackMention['action']>['kind'], { label: string; tone: 'neutral' | 'warn' | 'accent' | 'ok' }> = {
  none: { label: 'FYI', tone: 'neutral' },
  reply: { label: 'reply', tone: 'warn' },
  review: { label: 'review', tone: 'accent' },
  ticket: { label: 'ticket', tone: 'accent' },
  other: { label: 'to do', tone: 'warn' },
}

// Where you were tagged in Slack: the thread read and summarized, what to do, a reply you can send.
export function SlackMentions({ mentions }: { mentions: readonly SlackMention[] }) {
  const [checking, setChecking] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const open = mentions.filter((m) => m.status !== 'done')
  const done = mentions.filter((m) => m.status === 'done').slice(0, 10)
  if (!mentions.length) return null
  const check = async () => {
    setChecking(true)
    try {
      await slackActions.check()
    } catch (err) {
      failed(err)
    } finally {
      setChecking(false)
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-3">
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
        Slack mentions
        <span className="text-dim">{open.length}</span>
        <span className="ml-auto flex items-center gap-3 font-normal">
          {open.length > 2 && <ConfirmButton label="Mark all done" confirm={`Mark ${open.length} done`} onConfirm={() => void slackActions.doneAll().catch(failed)} />}
          {done.length > 0 && (
            <button type="button" className="hover:text-fg" onClick={() => setShowDone((x) => !x)}>
              {showDone ? 'Hide done' : `${done.length} done`}
            </button>
          )}
          <button type="button" className="hover:text-fg disabled:opacity-50" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </span>
      </div>
      {open.length === 0 && !showDone && <p className="px-1 text-xs text-dim">Nothing new.</p>}
      <AnimatePresence initial={false}>
        {(showDone ? [...open, ...done] : open).map((m) => (
          <Mention key={m.id} mention={m} />
        ))}
      </AnimatePresence>
    </section>
  )
}

export function Mention({ mention: m }: { mention: SlackMention }) {
  const [reply, setReply] = useState(m.action?.reply ?? '')
  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  useEffect(() => setReply(m.action?.reply ?? ''), [m.action?.reply])
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) notice({ title: ok, tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  const kind = m.action ? KIND[m.action.kind] : null
  return (
    <motion.article layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className={`flex flex-col gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-xs ${m.status === 'done' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <span className="font-medium text-fg-2">{m.from}</span>
        <span>in {m.channelName}</span>
        <span className="text-dim">{timeAgo(m.at)} ago</span>
        {kind && <Pill tone={kind.tone}>{kind.label}</Pill>}
        {m.permalink ? (
          <button type="button" className="ml-auto text-accent-fg hover:underline" onClick={() => void desktop.open(m.permalink)}>
            Open thread
          </button>
        ) : (
          m.test && <span className="ml-auto text-dim">test · posts go to your DM with the bot</span>
        )}
      </div>
      <p className="line-clamp-2 border-l-2 border-line-2 pl-2 text-fg-2">{m.text}</p>
      {m.status === 'summarizing' && (
        <motion.p className="text-muted" animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.4, repeat: Infinity }}>
          Reading the thread…
        </motion.p>
      )}
      {m.status === 'failed' && (
        <div className="flex items-center gap-2">
          <span className="text-bad">{m.error}</span>
          <Button disabled={busy} onClick={() => void run(() => slackActions.summarize(m.id))}>
            Try again
          </Button>
        </div>
      )}
      {m.summary && <p className="leading-relaxed text-fg">{m.summary}</p>}
      {m.night && <NightBlock mention={m} />}
      {m.action?.what && (
        <p className="text-fg-2">
          <span className="font-medium text-warn">To do: </span>
          {m.action.what}
        </p>
      )}
      {m.action?.links && m.action.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {m.action.links.map((l) => (
            <button key={l} type="button" className="truncate text-accent-fg hover:underline" onClick={() => void desktop.open(l)}>
              {l.replace(/^https:\/\/(www\.)?/, '').slice(0, 60)}
            </button>
          ))}
        </div>
      )}
      {m.status !== 'summarizing' && m.status !== 'new' && !m.test && <MentionRequest mention={m} />}
      {m.status !== 'done' && m.status !== 'summarizing' && (
        <div className="flex flex-col gap-1.5">
          {(m.action?.kind === 'reply' || writing || reply) && (
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Your reply in the thread" className="rounded-md border border-line-2 bg-panel px-2 py-1.5 text-fg outline-none focus:border-accent max-md:text-[16px]" />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {reply.trim() && <ConfirmButton variant="primary" label="Reply in the thread" confirm="Post as you in Slack" disabled={busy} onConfirm={() => void run(() => slackActions.reply(m.id, reply.trim()), 'Replied in Slack')} />}
            {!writing && !reply && m.action?.kind !== 'reply' && (
              <button type="button" className="text-muted hover:text-fg" onClick={() => setWriting(true)}>
                Write a reply
              </button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => slackActions.done(m.id))}>
              Done
            </Button>
          </div>
        </div>
      )}
    </motion.article>
  )
}

const NIGHT: Record<NonNullable<SlackMention['night']>['kind'], { label: string; tone: 'neutral' | 'warn' | 'accent' | 'ok' | 'bad' }> = {
  info: { label: 'FYI', tone: 'neutral' },
  fact: { label: 'mevo can answer', tone: 'ok' },
  decision: { label: 'needs you', tone: 'warn' },
  action: { label: 'asks to act', tone: 'warn' },
  outside: { label: 'not about your work', tone: 'neutral' },
  ignored: { label: 'ignored: fishing', tone: 'bad' },
  urgent: { label: 'urgent', tone: 'bad' },
}

// What Night Shift made of it: the kind, and what the bot would say (or said) in the thread.
function NightBlock({ mention: m }: { mention: SlackMention }) {
  const n = m.night!
  const answer = (n.draft ?? '').replace(/^:robot_face: _[^\n]*?_\s*/, '').trim()
  const [text, setText] = useState(answer)
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(answer), [answer])
  const k = NIGHT[n.kind]
  const send = async () => {
    setBusy(true)
    try {
      await nightActions.post(m.id, text.trim())
      notice({ title: 'Posted as mevo', tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line-2 bg-panel px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span aria-hidden="true">🌙</span>
        <Pill tone={k.tone}>{k.label}</Pill>
        <span className="min-w-0 flex-1 truncate">{n.why}</span>
      </div>
      {n.posted ? (
        <p className="text-[11px] text-ok">
          mevo answered in the thread {timeAgo(n.posted.at)} ago{n.posted.by === 'you' ? ', sent by you' : ''}
        </p>
      ) : (
        n.draft !== null && (
          <>
            <span className="text-[11px] text-dim">🤖 mevo, your assistant:</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="what mevo would post" className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-fg outline-none focus:border-accent max-md:text-[16px]" />
            <div className="flex items-center gap-2">
              {text.trim() && <ConfirmButton label="Post as mevo" confirm="Post in the thread as your assistant" variant="default" className="shrink-0" disabled={busy} onConfirm={() => void send()} />}
              <span className="text-[11px] text-dim max-md:hidden">posted by the bot with that label, never as you</span>
            </div>
          </>
        )
      )}
      {n.error && <p className="text-[11px] text-bad">{n.error}</p>}
    </div>
  )
}
