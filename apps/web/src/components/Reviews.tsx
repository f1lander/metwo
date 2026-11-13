import { ReviewFollowUpCard } from './FollowUp.js'
import type { LiveLine, MediaFile, OpenPr, PrReview, ReviewDepth, ReviewDraft, ReviewFinding } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { loadMedia, mediaUrl, reviewActions } from '../lib/api.js'
import { href } from '../lib/route.js'
import { LiveLog } from './Live.js'
import { Markdown } from './Markdown.js'
import { Avatar, Button, ConfirmButton, Mono, Person, Pill, rise, stagger, timeAgo } from './ui.js'
import { PrMetaCard } from './PrMeta.js'
import { failed } from '../lib/notice.js'
import { HandTestCard } from './HandTest.js'
import { finishedRuns, ReviewChat, reviewTicket } from './ReviewExtras.js'

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

const SOURCE: Record<PrReview['source'], string> = { requested: 'GitHub request', mentioned: 'GitHub mention', linear: 'Linear', manual: 'added by you', picked: 'picked by you' }

const DEPTH: Record<ReviewDepth, { label: string; hint: string }> = {
  code: { label: 'Code review', hint: 'Reads the diff, the issue and the repo rules. Nothing is installed or run. Cheapest.' },
  full: { label: 'Full review', hint: 'Checks the PR out in a worktree, installs, runs the gates, opens the app and tests the flows at desktop and mobile with screenshots. Steps for anything it cannot do.' },
}

// you posted, and the author pushed or answered since you last checked your comments
export const authorMoved = (r: PrReview) => Boolean(r.status === 'posted' && r.followUp && r.followUp.summary.resolved < r.followUp.summary.total && (r.followUp.commitsSince > 0 || r.followUp.summary.replied > 0) && r.followUp.checked?.sha !== r.followUp.sha)
export const reviewsWaiting = (reviews: readonly PrReview[]) => reviews.filter((r) => r.status === 'new' || r.status === 'reviewed' || (r.status === 'posted' && (r.stale || authorMoved(r)))).length

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
    { title: 'Waiting for you', items: reviews.filter((r) => ['new', 'reviewed', 'stopped', 'failed'].includes(r.status) || (r.status === 'posted' && (r.stale || authorMoved(r)))) },
    { title: 'In progress', items: reviews.filter((r) => r.status === 'reviewing' || r.status === 'queued') },
    { title: 'Done', items: reviews.filter((r) => ['posted', 'closed', 'dismissed'].includes(r.status) && !(r.status === 'posted' && (r.stale || authorMoved(r)))).slice(0, 12) },
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 py-6 max-md:px-4 max-md:pb-24">
        <motion.div variants={rise} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Reviews</h1>
            <p className="text-xs text-muted">PRs you were asked to review, mentioned in, pasted here, or picked from the open ones. Choose a code review (reads the diff) or a full review (runs it and tests it). mevo drafts the findings; you pick what goes and post it as a comment, an approval or a change request.</p>
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
        <OpenPrs />
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

const DECISION: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: 'approved', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'bad' },
  REVIEW_REQUIRED: { label: 'needs review', tone: 'neutral' },
}

// Every open PR ready for review that is not yours: pick one and the kind of review.
function OpenPrs() {
  const [prs, setPrs] = useState<OpenPr[] | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [mine, setMine] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setError(null)
    try {
      setPrs(await reviewActions.open())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    if (open && prs === null) void load()
  }, [open])
  const pick = async (n: number, depth: ReviewDepth) => {
    setBusy(n)
    try {
      const { review } = await reviewActions.pick(n, depth)
      window.location.hash = href.review(review.id)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const words = q.trim().toLowerCase()
  const shown = (prs ?? []).filter((p) => (!mine || p.requested) && (!words || `${p.number} ${p.title} ${p.author} ${p.labels.join(' ')}`.toLowerCase().includes(words)))
  return (
    <motion.section variants={rise} className="flex flex-col gap-2 rounded-lg border border-line bg-panel">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 px-4 py-3 text-left text-xs">
        <span className="font-medium text-fg">Open PRs ready for review</span>
        <span className="text-dim">{prs ? `${prs.length} from teammates` : 'all of them, not only the ones you were asked to review'}</span>
        <span className="ml-auto text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title, author, label or number" className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent max-md:text-[16px]" />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="accent-[var(--color-accent)]" />
              Requested from me
            </label>
            <Button onClick={() => void load()}>Refresh</Button>
          </div>
          {error && <p className="text-xs text-bad">{error}</p>}
          {prs === null && !error && <p className="text-xs text-muted">Loading the open PRs…</p>}
          {prs !== null && shown.length === 0 && <p className="text-xs text-dim">No open PRs match.</p>}
          <ul className="flex flex-col divide-y divide-line">
            {shown.map((p) => {
              const d = DECISION[p.reviewDecision]
              return (
                <li key={p.number} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-xs">
                  <Avatar login={p.author} size={20} />
                  <div className="min-w-0 flex-1 basis-64">
                    <a href={p.url} target="_blank" rel="noreferrer" className="block truncate font-medium text-fg hover:text-accent-fg">
                      {p.title}
                    </a>
                    <div className="truncate text-[11px] text-dim">
                      #{p.number} · {p.author} · {timeAgo(p.updatedAt)} ago · <span className="text-ok">+{p.additions}</span> <span className="text-bad">−{p.deletions}</span> · {p.files} file{p.files === 1 ? '' : 's'}
                      {p.labels.length ? ` · ${p.labels.slice(0, 3).join(', ')}` : ''}
                    </div>
                  </div>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {p.requested && <Pill tone="accent">requested from you</Pill>}
                    {d && <Pill tone={d.tone}>{d.label}</Pill>}
                    {p.review ? (
                      <a href={href.review(p.review)} className="rounded-md border border-line-2 px-2.5 py-1 text-fg-2 hover:text-fg">
                        On your list
                      </a>
                    ) : (
                      <>
                        <Button disabled={busy !== null} title={DEPTH.code.hint} onClick={() => void pick(p.number, 'code')}>
                          {busy === p.number ? 'Starting…' : 'Code review'}
                        </Button>
                        <Button variant="primary" disabled={busy !== null} title={DEPTH.full.hint} onClick={() => void pick(p.number, 'full')}>
                          Full review
                        </Button>
                      </>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </motion.section>
  )
}

function Row({ review: r }: { review: PrReview }) {
  const s = STATUS[r.status]
  const findings = r.report?.findings.length
  return (
    <a href={href.review(r.id)} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs transition-colors hover:border-line-2">
      <Avatar login={r.author} size={20} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-fg">{r.title}</div>
        <div className="truncate text-[11px] text-dim">
          #{r.number} · {r.author} · {r.sourceNote} · {timeAgo(r.requestedAt)} ago
        </div>
      </div>
      {r.stale && <Pill tone="warn">new commits</Pill>}
      {r.followUp && r.followUp.summary.total > 0 && (
        <Pill tone={r.followUp.summary.resolved === r.followUp.summary.total ? 'ok' : authorMoved(r) ? 'accent' : 'neutral'}>
          {r.followUp.summary.resolved}/{r.followUp.summary.total} of yours resolved
        </Pill>
      )}
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
        <motion.div variants={rise} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
          <a href={href.reviews} className="hover:text-fg">
            Reviews
          </a>
          <span className="text-dim">›</span>
          <span className="font-semibold whitespace-nowrap text-fg">PR #{r.number}</span>
          <Pill tone={s.tone}>{s.label}</Pill>
          {(r.report?.depth ?? r.depth) && <Pill>{DEPTH[r.report?.depth ?? r.depth ?? 'full'].label}</Pill>}
          {r.stale && <Pill tone="warn">new commits since the review</Pill>}
          <span className="ml-auto whitespace-nowrap">
            {r.report?.engine ?? ''}
            {cost > 0 ? ` · $${cost.toFixed(2)}` : ''}
          </span>
        </motion.div>
        <motion.h1 variants={rise} className="text-lg leading-snug font-semibold max-md:text-base">
          {r.title}
        </motion.h1>
        <motion.div variants={rise} className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Person login={r.author} className="text-fg-2" />
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
          {canStart &&
            (['code', 'full'] as const).map((d) => (
              <Button key={d} variant={d === 'full' && (r.status === 'new' || r.stale) ? 'primary' : 'default'} disabled={busy} title={DEPTH[d].hint} onClick={run(() => reviewActions.start(r.id, d))}>
                {DEPTH[d].label}
                {r.report ? ' again' : ''}
              </Button>
            ))}
          {(r.status === 'reviewing' || r.status === 'queued') && <ConfirmButton variant="default" label="Stop" confirm="Stop the review" disabled={busy} onConfirm={() => void run(() => reviewActions.stop(r.id))()} />}
          {r.status !== 'dismissed' && r.status !== 'closed' && (
            <Button variant="ghost" disabled={busy} onClick={run(() => reviewActions.dismiss(r.id))}>
              Dismiss
            </Button>
          )}
        </motion.div>
        <motion.div variants={rise}>
          <PrMetaCard kind="review" id={r.id} version={r.headSha} />
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

        {r.posted && (
          <motion.div variants={rise}>
            <ReviewFollowUpCard review={r} />
          </motion.div>
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
        <ReviewChat review={r} />
      </motion.div>
    </div>
  )
}

const EVENTS = [
  { id: 'COMMENT', label: 'Comment' },
  { id: 'REQUEST_CHANGES', label: 'Request changes' },
  { id: 'APPROVE', label: 'Approve' },
] as const

// The report as an editable draft: tick what to post, reword it, attach screenshots, add your hand
// test, pick the review type. The draft is saved as you type, so updates and reloads keep it.
type Draft = Omit<ReviewDraft, 'reportAt'>
const EVENT_TONE: Record<(typeof EVENTS)[number]['id'], { on: string; off: string }> = {
  COMMENT: { on: 'bg-[#1d1b33] text-accent-fg', off: 'text-muted hover:text-accent-fg' },
  REQUEST_CHANGES: { on: 'bg-[#2a1a1d] text-bad', off: 'text-muted hover:text-bad' },
  APPROVE: { on: 'bg-[#13261c] text-ok', off: 'text-muted hover:text-ok' },
}

function Report({ review: r, busy, setBusy }: { review: PrReview; busy: boolean; setBusy: (b: boolean) => void }) {
  const rep = r.report as NonNullable<PrReview['report']>
  const fresh = (): Draft => ({
    summary: rep.summary,
    event: rep.verdict === 'request_changes' ? 'REQUEST_CHANGES' : rep.verdict === 'approve' ? 'APPROVE' : 'COMMENT',
    findings: Object.fromEntries(rep.findings.map((f) => [f.id, { on: f.severity !== 'P3', body: f.body, shots: [] as string[] }])),
    tested: null,
  })
  const [d, setD] = useState<Draft>(() => (r.draft && r.draft.reportAt === rep.at ? r.draft : fresh()))
  const dirty = useRef(false)
  const seenAt = useRef(rep.at)
  // only a new report (a new review, or "check more") replaces the draft
  useEffect(() => {
    if (rep.at === seenAt.current) return
    seenAt.current = rep.at
    dirty.current = false
    setD(fresh())
  }, [rep.at]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => void reviewActions.draft(r.id, d).catch(() => undefined), 700)
    return () => clearTimeout(t)
  }, [d, r.id])
  const edit = (fn: (d: Draft) => Draft) => {
    dirty.current = true
    setD(fn)
  }
  const [note, setNote] = useState<string | null>(null)
  const [media, setMedia] = useState<readonly MediaFile[]>([])
  useEffect(() => {
    loadMedia(r.id)
      .then((m) => setMedia(Array.isArray(m) ? m.filter((x) => !x.previous && x.kind === 'image' && !x.name.startsWith('human--')) : []))
      .catch(() => setMedia([]))
  }, [r.id, rep.at])
  const picked = rep.findings.filter((f) => d.findings[f.id]?.on)
  const inline = picked.filter((f) => f.inline).length
  const shots = picked.reduce((n, f) => n + (d.findings[f.id]?.shots?.length ?? 0), 0)
  const runs = finishedRuns(r)
  const tested = runs.find((x) => x.id === d.tested)
  const post = async () => {
    setBusy(true)
    setNote(null)
    try {
      await reviewActions.post(r.id, { event: d.event, body: d.summary, findings: picked.map((f) => ({ id: f.id, body: d.findings[f.id]?.body ?? f.body, shots: d.findings[f.id]?.shots ?? [] })), tested: tested?.id ?? null })
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const red = rep.gates.filter((g) => !g.ok)
  const shotOf = (name: string | undefined) => (name ? media.find((m) => m.name === name || m.name.endsWith(name)) : undefined)
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
          <ul className="flex flex-col gap-1.5 text-xs">
            {rep.checks.map((c, i) => {
              const m = shotOf(c.shot)
              return (
                <li key={`${c.what}-${i}`} className="flex gap-2">
                  <span className={c.result === 'pass' ? 'text-ok' : c.result === 'fail' ? 'text-bad' : 'text-dim'}>{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '–'}</span>
                  <span className="min-w-0 flex-1 text-fg-2">
                    {c.what}
                    {c.note ? <span className="text-dim"> · {c.note}</span> : null}
                  </span>
                  {m && (
                    <a href={mediaUrl(r.id, m.name, m.at)} target="_blank" rel="noreferrer" className="shrink-0" title={m.name}>
                      <img src={mediaUrl(r.id, m.name, m.at)} alt={m.name} loading="lazy" className="h-10 w-16 rounded border border-line object-cover object-top hover:border-line-2" />
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </motion.section>

      {rep.manual && rep.manual.length > 0 && (
        <motion.section variants={rise} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted">Test it yourself · {rep.manual.length}</h2>
          {rep.manual.map((m) => (
            <div key={m.what} className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-panel px-4 py-3 text-xs">
              <span className="font-medium text-fg">{m.what}</span>
              {m.why && <span className="text-warn">{m.why}</span>}
              {m.steps.length > 0 && (
                <ol className="ml-4 list-decimal space-y-0.5 text-muted marker:text-dim">
                  {m.steps.map((st) => (
                    <li key={st}>{st}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </motion.section>
      )}
      {rep.depth === 'full' && r.worktree && (
        <motion.div variants={rise}>
          <HandTestCard ticket={reviewTicket(r)} />
        </motion.div>
      )}

      <motion.section variants={rise} className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted">
          Findings · {rep.findings.length} · {picked.length} picked
        </h2>
        {rep.findings.length === 0 && <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-xs text-dim">Nothing to flag.</div>}
        {rep.findings.map((f) => (
          <Finding key={f.id} reviewId={r.id} media={media} finding={f} value={d.findings[f.id] ?? { on: false, body: f.body }} onChange={(v) => edit((x) => ({ ...x, findings: { ...x.findings, [f.id]: v } }))} />
        ))}
      </motion.section>

      {r.status !== 'posted' || r.stale ? (
        <motion.section variants={rise} className="flex flex-col gap-2 rounded-lg border border-line-2 bg-raised px-4 py-3">
          <label htmlFor={`summary-${r.id}`} className="text-xs font-medium text-muted">
            Review comment
          </label>
          <textarea id={`summary-${r.id}`} value={d.summary} onChange={(e) => edit((x) => ({ ...x, summary: e.target.value }))} rows={4} className="rounded-md border border-line-2 bg-bg px-2.5 py-2 text-xs leading-relaxed text-fg outline-none focus:border-accent max-md:text-[16px]" />
          {runs.length > 0 && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={Boolean(tested)} onChange={(e) => edit((x) => ({ ...x, tested: e.target.checked ? (runs[0]?.id ?? null) : null }))} className="accent-[var(--color-accent)]" />
              Add my hand test to the review
              {tested && runs.length > 1 && (
                <select value={tested.id} onChange={(e) => edit((x) => ({ ...x, tested: e.target.value }))} className="rounded-md border border-line-2 bg-bg px-1.5 py-0.5 text-fg">
                  {runs.map((x) => (
                    <option key={x.id} value={x.id}>
                      {timeAgo(x.endedAt ?? x.startedAt)} ago · {x.status} · {x.steps.filter((st) => st.status === 'done').length}/{x.steps.length}
                    </option>
                  ))}
                </select>
              )}
              {tested && <span className="text-dim">each step with ✅/❌, and the screenshots of up to 6 steps</span>}
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label="review type">
              {EVENTS.map((e) => (
                <button key={e.id} type="button" role="radio" aria-checked={d.event === e.id} onClick={() => edit((x) => ({ ...x, event: e.id }))} className={`px-3 py-1 transition-colors ${d.event === e.id ? EVENT_TONE[e.id].on : EVENT_TONE[e.id].off}`}>
                  {e.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-dim">
              {inline} inline · {picked.length - inline} in the body{shots ? ` · ${shots} screenshot${shots === 1 ? '' : 's'}` : ''} · as you, on GitHub
            </span>
            <ConfirmButton variant="primary" className="ml-auto" label="Post review" confirm={`Post to #${r.number}`} disabled={busy} onConfirm={() => void post()} />
          </div>
          {note && <p className="text-xs text-bad">{note}</p>}
        </motion.section>
      ) : null}
    </>
  )
}

function Finding({ reviewId, media, finding: f, value, onChange }: { reviewId: string; media: readonly MediaFile[]; finding: ReviewFinding; value: { on: boolean; body: string; shots?: readonly string[] }; onChange: (v: { on: boolean; body: string; shots?: readonly string[] }) => void }) {
  const [picking, setPicking] = useState(false)
  const shots = value.shots ?? []
  const toggle = (name: string) => onChange({ ...value, shots: shots.includes(name) ? shots.filter((x) => x !== name) : [...shots, name].slice(0, 6) })
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
      {value.on && media.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {shots.map((name) => {
            const m = media.find((x) => x.name === name)
            return m ? (
              <button key={name} type="button" onClick={() => toggle(name)} title={`${name} · click to remove`} className="rounded border border-accent/60">
                <img src={mediaUrl(reviewId, m.name, m.at)} alt={name} className="h-10 w-16 rounded object-cover object-top" />
              </button>
            ) : null
          })}
          <button type="button" onClick={() => setPicking(!picking)} className="text-accent-fg hover:underline">
            {picking ? 'done' : shots.length ? 'change screenshots' : '+ screenshot'}
          </button>
        </div>
      )}
      {value.on && picking && (
        <div className="grid grid-cols-4 gap-1.5 max-sm:grid-cols-3">
          {media.map((m) => (
            <button key={m.name} type="button" onClick={() => toggle(m.name)} className={`overflow-hidden rounded border ${shots.includes(m.name) ? 'border-accent' : 'border-line hover:border-line-2'}`} title={m.name}>
              <img src={mediaUrl(reviewId, m.name, m.at)} alt={m.name} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
            </button>
          ))}
        </div>
      )}
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
