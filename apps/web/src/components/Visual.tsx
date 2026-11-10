import type { MediaFile, Ticket, VisualPlanView, VisualVerdict } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { actions, loadMedia, loadVisualPlan, mediaUrl } from '../lib/api.js'
import { PostToPr } from './PrDescPanel.js'
import { Button, Pill } from './ui.js'

const VERDICT: Record<VisualVerdict, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; blurb: string }> = {
  verified: { label: 'Visually verified', tone: 'ok', blurb: 'Every check passed and the lane saw each one.' },
  partial: { label: 'Partly verified', tone: 'warn', blurb: 'Some checks could not be reached. Look at what is missing before pushing.' },
  not_verified: { label: 'Not verified', tone: 'bad', blurb: 'The lane could not confirm the change visually. Check it yourself.' },
  not_applicable: { label: 'Nothing visual', tone: 'neutral', blurb: 'The change has nothing to look at.' },
}

// What the card and the ticket header say about visual testing for this ticket.
export function visualState(t: Ticket): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } | null {
  if (t.visualOverride === 'off') return null
  const needed = t.visualOverride === 'on' || t.visualNeeded === true
  if (t.visual) {
    if (t.visualStale) return { label: 'Visual check out of date', tone: 'warn' }
    return { label: VERDICT[t.visual.verdict].label, tone: VERDICT[t.visual.verdict].tone }
  }
  return needed ? { label: 'Needs visual check', tone: 'warn' } : null
}

const RESULT = { pass: { mark: '✓', cls: 'text-ok' }, fail: { mark: '✕', cls: 'text-bad' }, not_checked: { mark: '–', cls: 'text-dim' } } as const

const pairKey = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').replace(/(^|[-_])(before|after)(?=[-_]|$)/i, '$1').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ').trim()
const side = (name: string) => (/(^|[-_])before([-_.]|$)/i.test(name) ? 'before' : /(^|[-_])after([-_.]|$)/i.test(name) ? 'after' : null)

export function VisualTab({ ticket: t }: { ticket: Ticket }) {
  const [media, setMedia] = useState<readonly MediaFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<MediaFile | null>(null)
  const [compare, setCompare] = useState(false)

  useEffect(() => {
    loadMedia(t.id)
      .then((m) => {
        setMedia(m)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [t.id, t.status, t.commits, t.visualAt])

  const v = t.visual
  const previous = new Map((media ?? []).filter((m) => m.previous).map((m) => [m.name, m]))
  const images = media?.filter((m) => m.kind === 'image' && !m.previous) ?? []
  const videos = media?.filter((m) => m.kind === 'video') ?? []
  const groups = new Map<string, { before?: MediaFile; after?: MediaFile }>()
  for (const m of images) {
    const s = side(m.name)
    if (s) groups.set(pairKey(m.name), { ...groups.get(pairKey(m.name)), [s]: m })
  }
  const pairs = [...groups.entries()].filter(([, p]) => p.before && p.after)
  const paired = new Set(pairs.flatMap(([, p]) => [p.before?.name, p.after?.name]))
  const singles = images.filter((m) => !paired.has(m.name))
  const byName = new Map(images.map((m) => [m.name, m]))

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
      <VisualControls ticket={t} hasPrevious={previous.size > 0} compare={compare} setCompare={setCompare} />
      <PlanSteps ticket={t} />
      {v ? (
        <div className={`rounded-lg border px-4 py-3 ${v.verdict === 'verified' ? 'border-[#1f3b2c] bg-[#121b16]' : v.verdict === 'partial' ? 'border-[#3d3522] bg-[#1a1812]' : v.verdict === 'not_verified' ? 'border-[#4a2a2f] bg-[#1b1416]' : 'border-line bg-panel'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={VERDICT[v.verdict].tone}>{VERDICT[v.verdict].label}</Pill>
            {v.viewports?.map((vp) => (
              <span key={vp} className="font-mono text-[11px] text-muted">
                {vp}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">{v.summary || VERDICT[v.verdict].blurb}</p>
          {v.checks.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1">
              {v.checks.map((c, i) => {
                const shot = c.shot ? byName.get(c.shot) : undefined
                return (
                  <li key={`${c.what}-${i}`} className="flex items-start gap-2 text-xs">
                    <span className={`w-3 shrink-0 font-semibold ${RESULT[c.result].cls}`}>{RESULT[c.result].mark}</span>
                    <span className="flex-1 text-fg-2">
                      {c.what}
                      {c.note && <span className="text-muted"> · {c.note}</span>}
                    </span>
                    {shot && (
                      <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => setOpen(shot)}>
                        see shot
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-panel px-4 py-3 text-xs leading-relaxed text-muted">
          {t.status === 'running' || t.status === 'queued' ? 'The lane has not reported its visual check yet.' : 'No visual verdict for this ticket. Lanes started before this update did not write one; the Summary tab of the lane may still describe what it checked.'}
        </div>
      )}

      {error && <div className="text-xs text-muted">{error}</div>}
      {media && media.length === 0 && <div className="text-xs text-dim">No screenshots or videos saved for this ticket.</div>}

      {pairs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted">Before / after</h2>
          {pairs.map(([k, p]) => (
            <div key={k} className="flex flex-col gap-1.5">
              <div className="text-xs text-fg-2">{k}</div>
              <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
                {(['before', 'after'] as const).map((s) => {
                  const m = p[s] as MediaFile
                  const old = compare && s === 'before' ? previous.get((p.after as MediaFile).name) : undefined
                  // comparing: the previous run's "after" takes the left slot
                  if (old) return <Thumb key={s} ticket={t} file={{ ...old, name: `prev--${old.name}` }} label="after, previous run" onOpen={() => setOpen({ ...old, name: `prev--${old.name}` })} />
                  return <Thumb key={s} ticket={t} file={m} label={compare && s === 'after' ? 'after, this run' : s} onOpen={() => setOpen(m)} />
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {singles.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted">Screenshots · {singles.length}</h2>
          <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
            {singles.map((m) => {
              const old = compare ? previous.get(m.name) : undefined
              return old ? (
                <div key={m.name} className="col-span-2 grid grid-cols-2 gap-2 max-md:col-span-1 max-md:grid-cols-1">
                  <Thumb ticket={t} file={{ ...old, name: `prev--${old.name}` }} label={`previous run · ${m.name.replace(/\.[a-z]+$/i, '')}`} onOpen={() => setOpen({ ...old, name: `prev--${old.name}` })} />
                  <Thumb ticket={t} file={m} label={`this run · ${m.name.replace(/\.[a-z]+$/i, '')}`} onOpen={() => setOpen(m)} />
                </div>
              ) : (
                <Thumb key={m.name} ticket={t} file={m} label={m.name.replace(/\.[a-z]+$/i, '')} onOpen={() => setOpen(m)} />
              )
            })}
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted">Video · {videos.length}</h2>
          {videos.map((m) => (
            <figure key={m.name} className="flex flex-col gap-1">
              {/* biome-ignore lint/a11y/useMediaCaption: screen recordings have no audio */}
              <video src={mediaUrl(t.id, m.name, m.at)} controls preload="metadata" className="w-full rounded-lg border border-line bg-sunk" />
              <figcaption className="font-mono text-[11px] text-muted">{m.name}</figcaption>
            </figure>
          ))}
        </section>
      )}

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(null)}>
            <motion.img layoutId={`shot-${open.name}`} src={mediaUrl(t.id, open.name, open.at)} alt={open.name} className="max-h-full max-w-full rounded-lg border border-line-2 shadow-2xl" />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[11px] text-muted">{open.name} · click to close</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// The lane's test steps (steps mode) and what happened when mevo ran them. The same steps start
// Test by hand.
function PlanSteps({ ticket: t }: { ticket: Ticket }) {
  const [plan, setPlan] = useState<VisualPlanView | null>(null)
  const [code, setCode] = useState<string | null>(null)
  useEffect(() => {
    loadVisualPlan(t.id).then(setPlan, () => setPlan(null))
  }, [t.id, t.status, t.commits, t.visualAt, t.journal?.length])
  if (!plan) return null
  const mark = { passed: { m: '✓', c: 'text-ok' }, failed: { m: '✕', c: 'text-bad' }, skipped: { m: '–', c: 'text-dim' } } as const
  const shot = (name: string, label: string) => (
    <a key={name} href={mediaUrl(t.id, name)} target="_blank" rel="noreferrer" title={label} className="block overflow-hidden rounded border border-line hover:border-line-2">
      <img src={mediaUrl(t.id, name)} alt={label} loading="lazy" className="h-16 w-auto" />
    </a>
  )
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-fg">Test steps</span>
        <Pill tone={plan.ok === null ? 'neutral' : plan.ok ? 'ok' : 'warn'}>{plan.ok === null ? 'not run yet' : plan.ok ? 'mevo ran them' : 'a step failed'}</Pill>
        <span className="min-w-0 flex-1 text-[11px] text-dim">
          {plan.fellBack ? "They failed, so the AI took the screenshots below itself this round. " : ''}Written by the lane; the same steps start Test by hand.
        </span>
      </div>
      <ol className="flex flex-col divide-y divide-line">
        {plan.steps.map((s, i) => (
          <li key={s.id} className="flex flex-col gap-1 py-2 text-xs">
            <div className="flex items-start gap-2">
              <span className={`w-3 shrink-0 font-semibold ${s.status ? mark[s.status].c : 'text-dim'}`}>{s.status ? mark[s.status].m : '○'}</span>
              <span className="min-w-0 flex-1">
                <span className="text-fg">
                  {i + 1}. {s.title}
                </span>
                {s.go && <span className="ml-2 font-mono text-[11px] text-dim">{s.go}</span>}
                {s.proves && <span className="ml-2 text-[11px] text-dim">{s.proves}</span>}
                {s.expect && <span className="block text-muted">should show: {s.expect}</span>}
                <span className="block text-[11px] text-dim">
                  checked by {s.check.kind}
                  {s.check.value ? ` "${s.check.value}"` : ''}
                  {s.do && (
                    <button type="button" onClick={() => setCode(code === s.id ? null : s.id)} className="ml-2 text-accent-fg hover:underline">
                      {code === s.id ? 'hide the lines' : 'the lines mevo runs'}
                    </button>
                  )}
                </span>
                {s.error && <span className="block text-bad">{s.error}</span>}
              </span>
            </div>
            {code === s.id && s.do && <pre className="ml-5 overflow-x-auto rounded-md border border-line bg-sunk px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-fg-2">{s.do}</pre>}
            {(s.shots.length > 0 || s.before.length > 0 || s.failShot) && (
              <div className="ml-5 flex flex-wrap gap-1.5">
                {s.before.map((n) => shot(n, `before · ${n}`))}
                {s.shots.map((n) => shot(n, n))}
                {s.failShot && shot(s.failShot, 'what the page showed when it failed')}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function Thumb({ ticket: t, file, label, onOpen }: { ticket: Ticket; file: MediaFile; label: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex flex-col gap-1 text-left">
      <motion.img layoutId={`shot-${file.name}`} src={mediaUrl(t.id, file.name, file.at)} alt={label} loading="lazy" className="aspect-[16/10] w-full rounded-lg border border-line bg-sunk object-cover object-top transition-colors group-hover:border-line-2" />
      <span className="text-[11px] text-muted capitalize">{label}</span>
    </button>
  )
}

function VisualControls({ ticket: t, hasPrevious, compare, setCompare }: { ticket: Ticket; hasPrevious: boolean; compare: boolean; setCompare: (v: boolean) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const running = t.status === 'running' || t.status === 'queued'
  const mode = t.visualOverride ?? 'auto'
  const act = (key: string, fn: () => Promise<unknown>, done: string) => async () => {
    setBusy(key)
    setNote(null)
    try {
      await fn()
      setNote(done)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={running || busy !== null || !t.worktree} onClick={act('run', () => actions.visualRun(t), 'Visual check started; you get a Telegram message when it is done.')}>
          {running ? 'Running…' : t.visual ? 'Run visual check again' : 'Run visual check'}
        </Button>
        {t.prUrl && t.visual && (
          <Button disabled={busy !== null || running} onClick={() => setPosting((v) => !v)}>
            Post to PR{t.descProposal?.status === 'ready' ? ' · changes ready' : ''}
          </Button>
        )}
        {hasPrevious && (
          <Button variant="ghost" onClick={() => setCompare(!compare)}>
            {compare ? 'Hide previous run' : 'Compare with previous run'}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          Needs visual check
          <span className="flex overflow-hidden rounded-md border border-line-2" role="radiogroup" aria-label="needs visual check">
            {(['auto', 'on', 'off'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={act('override', () => actions.visualOverride(t, m === 'auto' ? null : m), '')}
                className={`px-2.5 py-1 capitalize ${mode === m ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
              >
                {m === 'auto' ? `auto${t.visualNeeded ? ' (yes)' : t.visualNeeded === false ? ' (no)' : ''}` : m}
              </button>
            ))}
          </span>
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-dim">Shoots every state this branch changes at 1440x900 and 390x844, compares with the last run and writes a verdict. It changes no code. Post to PR updates the description's checklists (you approve each line) or adds it as a comment.</p>
      {((posting && !t.descProposal) || t.descProposal?.trigger === 'visual') && t.prUrl && <PostToPr ticket={t} onClose={() => setPosting(false)} />}
      {note && <p className="text-xs text-fg-2">{note}</p>}
    </div>
  )
}
