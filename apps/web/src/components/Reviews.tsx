import type { LiveLine, MediaFile, PrReview, ReviewFinding } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { loadMedia, mediaUrl, reviewActions } from '../lib/api.js'
import { href } from '../lib/route.js'
import { LiveLog } from './Live.js'
import { Markdown } from './Markdown.js'
import { Button, ConfirmButton, Mono, Pill, rise, stagger, timeAgo } from './ui.js'
import { failed } from '../lib/notice.js'

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'

const STATUS: Record<PrReview['status'], { label: string; tone: Tone }> = {
  new: { label: 'To review', tone: 'warn' },
  queued: { label: 'Queued', tone: 'accent' },
  reviewing: { label: 'Reviewing', tone: 'accent' },
  reviewed: { label: 'Findings ready', tone: 'warn' },
  posted: { label: 'Posted', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'neutral' },
}

const SOURCE: Record<PrReview['source'], string> = { requested: 'GitHub request', mentioned: 'GitHub mention', linear: 'Linear', manual: 'added by you' }

export const reviewsWaiting = (reviews: readonly PrReview[]) => reviews.filter((r) => r.status === 'new' || r.status === 'reviewed' || (r.status === 'posted' && r.stale)).length

const sevTone = (s: string): Tone => (s === 'P0' || s === 'P1' ? 'bad' : s === 'P2' ? 'warn' : 'neutral')

export function ReviewsPage({ reviews }: { reviews: readonly PrReview[] }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setNote(null)
    try {
      const { review } = await reviewActions.add(url)
      await reviewActions.start(review.id)
      setUrl('')
      window.location.hash = href.review(review.id)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const groups: readonly { title: string; items: readonly PrReview[] }[] = [
    { title: 'Waiting for you', items: reviews.filter((r) => ['new', 'reviewed', 'stopped', 'failed'].includes(r.status) || (r.status === 'posted' && r.stale)) },
    { title: 'In progress', items: reviews.filter((r) => r.status === 'reviewing' || r.status === 'queued') },
    { title: 'Done', items: reviews.filter((r) => ['posted', 'closed', 'dismissed'].includes(r.status) && !(r.status === 'posted' && r.stale)).slice(0, 12) },
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 py-6 max-md:px-4 max-md:pb-24">
        <motion.div variants={rise} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Reviews</h1>
            <p className="text-xs text-muted">PRs you were asked to review on GitHub, mentioned with a PR link in Linear, or pasted here (from Slack). metwo runs the branch and drafts findings; nothing is posted until you pick what goes.</p>
          </div>
          <Button disabled={busy} onClick={() => void reviewActions.refresh()}>
            Check now
          </Button>
        </motion.div>
        <motion.form variants={rise} onSubmit={(e) => void add(e)} className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a PR link or number to review it"
            className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-3 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent max-md:min-h-10 max-md:text-[16px]"
          />
          <Button variant="primary" type="submit" disabled={busy || !url.trim()}>
            Review
          </Button>
        </motion.form>
        {note && <p className="text-xs text-bad">{note}</p>}
        {groups.map((g) => (
          <motion.section key={g.title} variants={rise} className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted">
              {g.title} · {g.items.length}
            </h2>
            {g.items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-xs text-dim">Nothing here.</div>
            ) : (
              g.items.map((r) => <Row key={r.id} review={r} />)
            )}
          </motion.section>
        ))}
      </motion.div>
    </div>
  )
}

function Row({ review: r }: { review: PrReview }) {
  const s = STATUS[r.status]
  const findings = r.report?.findings.length
  return (
    <a href={href.review(r.id)} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs transition-colors hover:border-line-2">
      <Mono className="shrink-0 text-muted">#{r.number}</Mono>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-fg">{r.title}</div>
        <div className="truncate text-[11px] text-dim">
          {r.author} · {r.sourceNote} · {timeAgo(r.requestedAt)} ago
        </div>
      </div>
      {r.stale && <Pill tone="warn">new commits</Pill>}
      {findings !== undefined && r.status !== 'reviewing' && <Pill>{findings} finding{findings === 1 ? '' : 's'}</Pill>}
      <Pill tone={s.tone}>{s.label}</Pill>
    </a>
  )
}

export function ReviewView({ review: r, live }: { review: PrReview; live: readonly LiveLine[] }) {
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  const s = STATUS[r.status]
  const cost = (r.journal ?? []).reduce((n, j) => n + Number(j.meta?.cost ?? 0), 0)
  const canStart = ['new', 'stopped', 'failed', 'reviewed', 'posted'].includes(r.status)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,7fr)_minmax(0,5fr)] grid-rows-[minmax(0,1fr)] max-lg:flex max-lg:flex-col max-lg:overflow-y-auto max-md:pb-24">
      <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line px-6 py-5 max-lg:shrink-0 max-lg:overflow-visible max-lg:border-r-0 max-md:px-4">
        <motion.div variants={rise} className="flex items-center gap-2 text-xs text-muted">
          <a href={href.reviews} className="hover:text-fg">
            Reviews
          </a>
          <span className="text-dim">›</span>
          <span className="font-semibold text-fg">PR #{r.number}</span>
          <Pill tone={s.tone}>{s.label}</Pill>
          {r.stale && <Pill tone="warn">new commits since the review</Pill>}
          <span className="ml-auto">
            {r.report?.engine ?? ''}
            {cost > 0 ? ` · $${cost.toFixed(2)}` : ''}
          </span>
        </motion.div>
        <motion.h1 variants={rise} className="text-lg leading-snug font-semibold max-md:text-base">
          {r.title}
        </motion.h1>
        <motion.div variants={rise} className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{r.author}</span>
          <Pill>{SOURCE[r.source]}</Pill>
          <span>{r.sourceNote}</span>
          <a href={r.url} target="_blank" rel="noreferrer" className="text-accent-fg">
            Open on GitHub
          </a>
          <Mono className="text-dim">
            {r.head} → {r.base}
          </Mono>
        </motion.div>

        <motion.div variants={rise} className="flex flex-wrap gap-2">
          {canStart && (
            <Button variant={r.status === 'new' || r.stale ? 'primary' : 'default'} disabled={busy} onClick={run(() => reviewActions.start(r.id))}>
              {r.report ? 'Review again' : 'Review it'}
            </Button>
          )}
          {(r.status === 'reviewing' || r.status === 'queued') && <ConfirmButton variant="default" label="Stop" confirm="Stop the review" disabled={busy} onConfirm={() => void run(() => reviewActions.stop(r.id))()} />}
          {r.status !== 'dismissed' && r.status !== 'closed' && (
            <Button variant="ghost" disabled={busy} onClick={run(() => reviewActions.dismiss(r.id))}>
              Dismiss
            </Button>
          )}
        </motion.div>
        {r.status === 'failed' && r.error && <p className="text-xs text-bad">{r.error}</p>}
        {r.posted && (
          <p className="text-xs text-fg-2">
            Posted {timeAgo(r.posted.at)} ago as {r.posted.event.toLowerCase().replace('_', ' ')} with {r.posted.comments} inline comment(s).{' '}
            {r.posted.url && (
              <a href={r.posted.url} target="_blank" rel="noreferrer" className="text-accent-fg">
                See it on GitHub
              </a>
            )}
          </p>
        )}

        {r.report && <Report review={r} busy={busy} setBusy={setBusy} />}
        <Shots id={r.id} at={r.report?.at} />

        <motion.details variants={rise} className="rounded-lg border border-line bg-panel px-4 py-3" open={!r.report}>
          <summary className="cursor-pointer text-xs font-medium text-muted">PR description</summary>
          <Markdown source={r.body || '_empty_'} className="mt-3" />
        </motion.details>
      </motion.div>
      <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-col gap-4 px-6 py-5 max-lg:min-h-[320px] max-lg:shrink-0 max-lg:border-t max-lg:border-line max-md:px-4">
        <LiveLog id={r.id} lines={live} running={r.status === 'reviewing'} className="flex-1" />
      </motion.div>
    </div>
  )
}

const EVENTS = [
  { id: 'COMMENT', label: 'Comment' },
  { id: 'REQUEST_CHANGES', label: 'Request changes' },
  { id: 'APPROVE', label: 'Approve' },
] as const

// The report as an editable draft: tick what to post, reword it, pick the review type.
function Report({ review: r, busy, setBusy }: { review: PrReview; busy: boolean; setBusy: (b: boolean) => void }) {
  const rep = r.report as NonNullable<PrReview['report']>
  const initial = useMemo(() => Object.fromEntries(rep.findings.map((f) => [f.id, { on: f.severity !== 'P3', body: f.body }])), [rep])
  const [draft, setDraft] = useState<Record<string, { on: boolean; body: string }>>(initial)
  const [summary, setSummary] = useState(rep.summary)
  const [event, setEvent] = useState<(typeof EVENTS)[number]['id']>(rep.verdict === 'request_changes' ? 'REQUEST_CHANGES' : rep.verdict === 'approve' ? 'APPROVE' : 'COMMENT')
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    setDraft(initial)
    setSummary(rep.summary)
  }, [initial, rep.summary])
  const picked = rep.findings.filter((f) => draft[f.id]?.on)
  const inline = picked.filter((f) => f.inline).length
  const post = async () => {
    setBusy(true)
    setNote(null)
    try {
      await reviewActions.post(r.id, { event, body: summary, findings: picked.map((f) => ({ id: f.id, body: draft[f.id]?.body ?? f.body })) })
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const red = rep.gates.filter((g) => !g.ok)
  return (
    <>
      <motion.section variants={rise} className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">Verdict</span>
          <Pill tone={rep.verdict === 'approve' ? 'ok' : rep.verdict === 'request_changes' ? 'bad' : 'warn'}>{rep.verdict.replace('_', ' ')}</Pill>
          <span className="text-dim">on {rep.sha.slice(0, 8)}</span>
          <span className="ml-auto flex flex-wrap gap-1.5">
            {rep.gates.map((g) => (
              <Pill key={g.name} tone={g.ok ? 'ok' : 'bad'}>
                {g.ok ? '✓' : '✕'} {g.name}
              </Pill>
            ))}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-fg-2">{rep.summary}</p>
        {red.map((g) => (
          <pre key={g.name} className="max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-[11px] text-muted">
            {g.tail}
          </pre>
        ))}
        {rep.checks.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs">
            {rep.checks.map((c, i) => (
              <li key={`${c.what}-${i}`} className="flex gap-2">
                <span className={c.result === 'pass' ? 'text-ok' : c.result === 'fail' ? 'text-bad' : 'text-dim'}>{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '–'}</span>
                <span className="text-fg-2">
                  {c.what}
                  {c.note ? <span className="text-dim"> · {c.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </motion.section>

      <motion.section variants={rise} className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted">
          Findings · {rep.findings.length} · {picked.length} picked
        </h2>
        {rep.findings.length === 0 && <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-xs text-dim">Nothing to flag.</div>}
        {rep.findings.map((f) => (
          <Finding key={f.id} finding={f} value={draft[f.id] ?? { on: false, body: f.body }} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
        ))}
      </motion.section>

      {r.status !== 'posted' || r.stale ? (
        <motion.section variants={rise} className="flex flex-col gap-2 rounded-lg border border-line-2 bg-raised px-4 py-3">
          <label htmlFor={`summary-${r.id}`} className="text-xs font-medium text-muted">
            Review comment
          </label>
          <textarea id={`summary-${r.id}`} value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} className="rounded-md border border-line-2 bg-bg px-2.5 py-2 text-xs leading-relaxed text-fg outline-none focus:border-accent max-md:text-[16px]" />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label="review type">
              {EVENTS.map((e) => (
                <button key={e.id} type="button" role="radio" aria-checked={event === e.id} onClick={() => setEvent(e.id)} className={`px-3 py-1 ${event === e.id ? 'bg-bg text-fg' : 'text-muted hover:text-fg'}`}>
                  {e.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-dim">
              {inline} inline · {picked.length - inline} in the body · as you, on GitHub
            </span>
            <ConfirmButton variant="primary" className="ml-auto" label="Post review" confirm={`Post to #${r.number}`} disabled={busy} onConfirm={() => void post()} />
          </div>
          {note && <p className="text-xs text-bad">{note}</p>}
        </motion.section>
      ) : null}
    </>
  )
}

function Finding({ finding: f, value, onChange }: { finding: ReviewFinding; value: { on: boolean; body: string }; onChange: (v: { on: boolean; body: string }) => void }) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors ${value.on ? 'border-line-2 bg-panel' : 'border-line bg-sunk opacity-70'}`}>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" />
        <Pill tone={sevTone(f.severity)}>{f.severity}</Pill>
        <span className="min-w-0 flex-1 font-medium text-fg">{f.title}</span>
      </label>
      {f.file && (
        <Mono className="text-muted">
          {f.file}
          {f.line ? `:${f.line}` : ''} · {f.inline ? 'inline comment' : 'outside the diff, goes in the review body'}
        </Mono>
      )}
      <textarea value={value.body} onChange={(e) => onChange({ ...value, body: e.target.value })} rows={Math.min(8, Math.max(2, Math.ceil(value.body.length / 90)))} disabled={!value.on} className="rounded-md border border-line bg-bg px-2.5 py-2 text-xs leading-relaxed text-fg-2 outline-none focus:border-accent disabled:opacity-60 max-md:text-[16px]" />
      {f.suggestion && <pre className="overflow-auto rounded-md bg-sunk p-2 font-mono text-[11px] text-ok">{f.suggestion}</pre>}
    </div>
  )
}

function Shots({ id, at }: { id: string; at: string | undefined }) {
  const [media, setMedia] = useState<readonly MediaFile[]>([])
  useEffect(() => {
    loadMedia(id)
      .then((m) => setMedia(Array.isArray(m) ? m.filter((x) => !x.previous && x.kind === 'image') : []))
      .catch(() => setMedia([]))
  }, [id, at])
  if (media.length === 0) return null
  return (
    <motion.section variants={rise} className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted">Screenshots from the review · {media.length}</h2>
      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        {media.map((m) => (
          <a key={m.name} href={mediaUrl(id, m.name, m.at)} target="_blank" rel="noreferrer" className="group flex flex-col gap-1">
            <img src={mediaUrl(id, m.name, m.at)} alt={m.name} loading="lazy" className="aspect-[16/10] w-full rounded-lg border border-line bg-sunk object-cover object-top group-hover:border-line-2" />
            <Mono className="truncate text-dim">{m.name}</Mono>
          </a>
        ))}
      </div>
    </motion.section>
  )
}
