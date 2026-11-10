import type { AndroidDevice, HumanTestRun, TestCheckKind, TestStep, Ticket } from '@ticketflow/shared'
import { useEffect, useState } from 'react'
import { actions, mediaUrl } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { PhoneMirror } from './PhoneMirror.js'
import { Button, Mono, Pill, timeAgo } from './ui.js'


const CHECK: Record<TestCheckKind, string> = {
  url: 'mevo sees the page',
  text: 'mevo sees the text',
  selector: 'mevo sees it on screen',
  rpc: 'mevo sees the wallet',
  tx: 'mevo sees the transaction',
  clipboard: 'mevo sees the copy',
  manual: 'you mark it',
}
const KINDS = Object.keys(CHECK) as TestCheckKind[]
const RUN_TONE: Record<HumanTestRun['status'], 'ok' | 'bad' | 'warn' | 'accent' | 'neutral'> = { passed: 'ok', failed: 'bad', incomplete: 'warn', error: 'bad', running: 'accent', starting: 'accent' }
const mark = { pending: '○', done: '✓', failed: '✕', skipped: '–' } as const
const shotUrl = (id: string, file: string) => mediaUrl(id, `human--${file.replace('/', '--')}`)

// why this ticket is worth testing on a phone, if it is
export function mobileHint(t: Ticket): string | null {
  const text = [t.title, t.description ?? '', ...(t.labels ?? [])].join(' ')
  const word = /\b(mobile|phones?|android|ios|iphone|touch|responsive|small screens?|390(?:px)?)\b/i.exec(text)?.[1]
  if (word) return `the ticket says "${word.toLowerCase()}"`
  const file = (t.diffStat ?? '')
    .split('\n')
    .map((l) => l.split('|')[0]?.trim() ?? '')
    .find((f) => /mobile|sheet|drawer|touch|swipe/i.test(f))
  if (file) return `the diff touches ${file.split('/').pop()}`
  if (t.visual?.viewports?.some((v) => /^(3\d\d|4[0-2]\d)x/.test(v))) return 'the visual check covers a phone width'
  return null
}

type Where = 'preview' | 'mock' | 'chrome' | string
const seconds = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
const elapsed = (iso: string) => {
  const s = seconds(iso)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// You test it by hand in a real browser while mevo watches. One compact row: what to do and
// Start; while it runs, the stage or the progress; after, the result. The steps, the editor and
// the certificates open under it.
export function HandTestCard({ ticket: t, phones = [] }: { ticket: Ticket; phones?: readonly AndroidDevice[] }) {
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<TestStep[] | null>(null)
  const [open, setOpen] = useState<null | 'steps' | 'runs' | 'error'>(null)
  const [pick, setPick] = useState<Where | null>(null)
  const [again, setAgain] = useState(false)
  const [, tick] = useState(0)
  const plan = t.testPlan
  const live = t.humanTests?.find((r) => r.status === 'starting' || r.status === 'running')
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])
  if (!t.worktree) return null
  const runs = (t.humanTests ?? []).filter((r) => r !== live)
  const latest = runs[0]
  const head = t.pr?.headSha ?? t.pushedSha
  const stale = (r: HumanTestRun) => Boolean(head && r.sha && !head.startsWith(r.sha.slice(0, 7)))
  const recentError = latest?.status === 'error' && seconds(latest.endedAt ?? latest.startedAt) < 6 * 3600 ? latest : null
  const tested = latest && latest.status === 'passed' && !again ? latest : null
  const ready = phones.filter((d) => d.state === 'device')
  const hint = mobileHint(t)
  // a plan that needs a real wallet on the preview: your Chrome with MetaMask
  const needsWallet = plan?.steps.some((x) => x.check.kind === 'rpc' || x.check.kind === 'tx')
  const best: Where = hint && ready[0] ? ready[0].serial : plan?.where === 'chrome' || (needsWallet && plan?.where !== 'mock') ? 'chrome' : plan?.where === 'preview' && t.pr ? 'preview' : 'mock'
  const where: Where = pick && (pick === 'mock' || pick === 'chrome' || (pick === 'preview' && t.pr) || ready.some((d) => d.serial === pick)) ? pick : best
  const phone = ready.find((d) => d.serial === where)
  const go = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setBusy(true)
    try {
      await fn()
      if (ok) notice({ id: t.id, title: ok, tone: 'ok' })
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  const start = (w: Where) => go(async () => {
    setAgain(false)
    setOpen(null)
    await actions.handTest(t, w === 'preview' || w === 'chrome' ? w : 'mock', w === 'preview' || w === 'mock' || w === 'chrome' ? undefined : w)
  })
  const toggle = (v: 'steps' | 'runs' | 'error') => setOpen((o) => (o === v ? null : v))
  const auto = plan?.steps.filter((s) => s.check.kind !== 'manual').length ?? 0
  const placeName = (w: Where) => (w === 'preview' ? 'the preview' : w === 'mock' ? 'the test wallet' : w === 'chrome' ? 'your Chrome' : `the ${ready.find((d) => d.serial === w)?.model ?? 'phone'}`)

  const tone = live ? 'border-accent/40 bg-accent/[.06]' : recentError && !again ? 'border-[#5a2626] bg-[#1f1415]' : tested ? 'border-[#1f4a31] bg-[#121a15]' : 'border-line bg-panel'
  const chevron = (v: 'steps' | 'runs' | 'error', label: string) => (
    <button type="button" aria-expanded={open === v} aria-label={label} onClick={() => toggle(v)} className="w-4 shrink-0 text-[11px] text-muted hover:text-fg">
      {open === v ? '▾' : '▸'}
    </button>
  )
  const places = [...(t.pr ? [{ k: 'preview', l: 'Preview', why: "the PR's preview deploy, as people get it" }] : []), { k: 'mock', l: 'Test wallet', why: 'the e2e setup: the app from this worktree on the local chain; mevo connects the test wallet for you, signatures go through and transactions wait for Approve in the sidebar' }, { k: 'chrome', l: 'Your Chrome', why: 'your own Chrome and MetaMask, on the app from this worktree on Sepolia; the steps panel comes with the page and takes you to each step' }, ...ready.map((d) => ({ k: d.serial, l: d.model, why: `Chrome on the ${d.model} (${d.transport})` }))]
  const seg = places.length === 1 ? (
    <span className="shrink-0 text-xs text-muted" title={places[0]?.why}>on the test wallet</span>
  ) : (
    <span className="inline-flex shrink-0 rounded-md border border-line-2 p-0.5" role="group" aria-label="where to test">
      {places.map((o) => (
        <button key={o.k} type="button" title={o.why} aria-pressed={where === o.k} onClick={() => setPick(o.k)} className={`rounded px-2 py-0.5 text-xs whitespace-nowrap ${where === o.k ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
          {o.l}
        </button>
      ))}
    </span>
  )
  const startButton = (label = 'Start', w: Where = where) => (
    <Button variant="primary" disabled={busy} title={`opens ${placeName(w)} with the steps inside the page`} onClick={start(w)}>
      <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M1 1l7 4-7 4z" fill="currentColor" /></svg>
      {label}
    </Button>
  )

  let row: React.ReactNode
  if (live) {
    const done = live.steps.filter((s) => s.status === 'done').length
    const now = live.plan.find((p) => p.id === live.steps.find((s) => s.status === 'pending')?.id)
    row = (
      <>
        <span aria-hidden="true" className="flex w-4 justify-center"><span className={`size-2 rounded-full ${live.status === 'running' ? 'bg-ok' : 'animate-pulse bg-accent-fg'}`} /></span>
        {live.status === 'starting' ? (
          <>
            <span className="font-medium text-fg">{live.detail ?? 'Getting ready'}</span>
            <span className="text-muted">{elapsed(live.startedAt)}{live.device ? ` · ${live.device.model}` : ''}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-fg whitespace-nowrap">{done} of {live.steps.length} done</span>
            <span className="flex h-1 w-40 shrink-0 rounded-full bg-raised" aria-hidden="true"><span className="rounded-full bg-accent-fg" style={{ width: `${Math.round((done / Math.max(1, live.steps.length)) * 100)}%` }} /></span>
            {live.mode === 'chrome' && (
              <a href={live.url} target="_blank" rel="noreferrer" className="text-accent-fg hover:underline">
                open it again
              </a>
            )}
            <span className="min-w-24 flex-1 truncate text-muted" title={live.note}>{live.pendingTx ? <span className="text-warn">the test wallet waits for your Approve in the page</span> : live.note && /^Connect/.test(live.note) && done === 0 ? <span className={live.note.startsWith('Connect the wallet yourself') ? 'text-warn' : ''}>{live.note}</span> : now ? `now: ${now.title}` : 'all done: Finish in the page'}</span>
          </>
        )}
        <Button className="ml-auto" disabled={busy} onClick={go(() => actions.stopHandTest(t))}>
          Stop
        </Button>
      </>
    )
  } else if (!plan) {
    row = (
      <>
        <span className="w-4" />
        <span className="font-medium text-fg">Test it by hand</span>
        <span className="min-w-24 flex-1 truncate text-muted">mevo writes the steps, opens the app with them inside the page and ticks what it sees</span>
        <Button className="ml-auto" variant="primary" disabled={busy} onClick={go(() => actions.testPlan(t), 'Steps written')}>
          {busy ? 'Writing…' : 'Write the steps'}
        </Button>
      </>
    )
  } else if (recentError && !again) {
    row = (
      <>
        <span aria-hidden="true" className="w-4 text-center font-bold text-bad">!</span>
        <span className="font-medium whitespace-nowrap text-[#fca5a5]">Didn’t start</span>
        <span className="min-w-24 flex-1 truncate text-fg-2" title={recentError.detail}>{recentError.detail}</span>
        <button type="button" className="ml-auto shrink-0 text-xs text-muted hover:text-fg" onClick={() => toggle('error')}>{open === 'error' ? 'Hide' : 'Details'}</button>
        {startButton('Try again', recentError.device?.serial ?? recentError.mode)}
        <button type="button" className="shrink-0 text-xs text-muted hover:text-fg" onClick={() => setAgain(true)}>Other options</button>
      </>
    )
  } else if (tested) {
    const shots = tested.steps.filter((s) => s.shot).slice(0, 3)
    row = (
      <>
        <span aria-hidden="true" className="w-4 text-center text-ok">✓</span>
        <span className="font-medium whitespace-nowrap text-[#86efac]">Tested by hand</span>
        <span className="min-w-24 flex-1 truncate text-muted">
          {tested.steps.filter((s) => s.status === 'done').length}/{tested.steps.length} · {tested.device?.model ?? (tested.mode === 'mock' ? 'test wallet' : tested.mode === 'chrome' ? 'your Chrome' : 'preview')} · {tested.tester} · {timeAgo(tested.endedAt ?? tested.startedAt)} ago · on {tested.sha.slice(0, 7)}
        </span>
        {stale(tested) && <Pill tone="warn">new commits since</Pill>}
        <span className="flex shrink-0 gap-1 max-md:hidden" aria-hidden="true">
          {shots.map((s) => <img key={s.id} src={shotUrl(t.id, s.shot as string)} alt="" className="h-[22px] w-[34px] rounded border border-line-2 object-cover object-top" />)}
        </span>
        <button type="button" className="ml-auto shrink-0 text-xs text-accent-fg hover:underline" onClick={() => toggle('runs')}>{open === 'runs' ? 'Hide' : 'Certificate ›'}</button>
        <Button variant="ghost" disabled={busy} onClick={() => setAgain(true)}>Test again</Button>
      </>
    )
  } else {
    row = (
      <>
        {chevron('steps', open === 'steps' ? 'Hide the steps' : 'Show the steps')}
        <button type="button" className="font-medium whitespace-nowrap text-fg" onClick={() => toggle('steps')}>Test it by hand</button>
        <span className="min-w-24 flex-1 truncate text-muted">
          {plan.steps.length} steps · {auto} checked by mevo{plan.where ? ` · best on ${plan.where === 'preview' ? `the preview${t.pr ? '' : ' (no PR yet)'}` : plan.where === 'chrome' ? 'your Chrome' : 'the test wallet'}` : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {seg}
          {startButton()}
        </span>
      </>
    )
  }

  return (
    <section aria-label="Test it by hand" className={`flex flex-col rounded-xl border text-[13px] ${tone}`}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-3 pl-3.5">{row}</div>
      {live?.device && (
        <div className="border-t border-line px-3.5 py-3">
          <RunView ticket={t} run={live} phone={phones.find((d) => d.serial === live.device?.serial)} />
        </div>
      )}
      {!live && open === 'error' && recentError && <pre className="mx-3.5 mb-3 max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{recentError.detail}</pre>}
      {!live && open === 'steps' && plan && (
        <div className="flex flex-col gap-2.5 border-t border-line px-3.5 py-3">
          {edit ? (
            <StepEditor steps={edit} onChange={setEdit} onCancel={() => setEdit(null)} onSave={go(async () => {
              await actions.saveTestPlan(t, edit)
              setEdit(null)
            }, 'Steps saved')} busy={busy} />
          ) : (
            <>
              <ol className="ml-6 grid grid-cols-2 gap-x-7 gap-y-1 text-[12.5px] max-md:ml-0 max-md:grid-cols-1">
                {plan.steps.map((s, i) => (
                  <li key={s.id} className="flex min-w-0 gap-2" title={[s.how, s.expect && `Expect: ${s.expect}`].filter(Boolean).join('\n')}>
                    <span className="w-4 shrink-0 text-right text-muted">{i + 1}</span>
                    <span className="truncate text-fg">{s.title}</span>
                    <span className={`shrink-0 text-[11px] ${s.check.kind === 'manual' ? 'text-muted' : 'text-accent-fg'}`}>{s.check.kind === 'manual' ? 'you' : 'auto'}</span>
                  </li>
                ))}
              </ol>
              <div className="ml-6 flex flex-wrap items-center gap-3 text-xs text-muted max-md:ml-0">
                {plan.whereWhy && <span>Best on {plan.where === 'preview' ? 'the preview' : plan.where === 'chrome' ? 'your Chrome' : 'the test wallet'}: {plan.whereWhy.replace(/\.$/, '')}.</span>}
                {hint && !ready.length && <span>Mobile change ({hint}): plug in an Android phone to test it there.</span>}
                <span className="ml-auto flex gap-3">
                  <button type="button" className="hover:text-fg" onClick={() => setEdit(plan.steps.map((s) => ({ ...s })))}>Edit</button>
                  <button type="button" className="hover:text-fg" disabled={busy} onClick={go(() => actions.testPlan(t), 'Steps written')}>Rewrite</button>
                  {runs.length > 0 && <button type="button" className="hover:text-fg" onClick={() => setOpen('runs')}>Past runs ({runs.length})</button>}
                </span>
              </div>
            </>
          )}
        </div>
      )}
      {!live && open === 'runs' && runs.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line px-3.5 py-3">
          {runs.slice(0, 5).map((r) => (
            <Certificate key={r.id} ticket={t} run={r} stale={stale(r)} />
          ))}
        </div>
      )}
      {phone && !live && <span className="sr-only">testing on {phone.model}</span>}
    </section>
  )
}

function RunView({ run: r, phone }: { ticket: Ticket; run: HumanTestRun; phone?: AndroidDevice | undefined }) {
  if (!r.device) return null
  const done = r.steps.filter((s) => s.status === 'done').length
  return (
    <div className="flex flex-wrap gap-4">
      <PhoneMirror serial={r.device.serial} model={r.device.model} width={phone?.width} height={phone?.height} className="w-[240px] shrink-0" />
      <ol className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {r.steps.map((s, i) => (
          <li key={s.id} className="flex items-baseline gap-2">
            <span className={s.status === 'done' ? 'text-ok' : s.status === 'failed' ? 'text-bad' : 'text-muted'}>{mark[s.status]}</span>
            <span className={s.status === 'pending' ? 'text-fg-2' : 'text-fg'}>
              {i + 1}. {r.plan.find((p) => p.id === s.id)?.title}
            </span>
            {s.detail && <span className="truncate text-muted">{s.detail}</span>}
          </li>
        ))}
        <li className="mt-1 text-muted">{done} of {r.steps.length} · finish from the mevo pill on the phone</li>
      </ol>
    </div>
  )
}

function Certificate({ ticket: t, run: r, stale }: { ticket: Ticket; run: HumanTestRun; stale: boolean }) {
  const [open, setOpen] = useState(false)
  const done = r.steps.filter((s) => s.status === 'done').length
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex flex-wrap items-center gap-2 text-left">
        <Pill tone={RUN_TONE[r.status]}>{r.status === 'passed' ? '✓ tested by hand' : r.status}</Pill>
        <span className="text-fg-2">
          {done}/{r.steps.length} steps · {r.device ? `${r.device.model}${r.device.chrome ? ` · Chrome ${r.device.chrome}` : ''} · ` : ''}{r.mode === 'mock' ? 'test wallet' : r.mode === 'chrome' ? 'your Chrome' : 'preview'} · {r.tester} · {timeAgo(r.endedAt ?? r.startedAt)} ago
        </span>
        <Mono className="text-dim">{r.sha.slice(0, 7)}</Mono>
        {stale && <Pill tone="warn">new commits since</Pill>}
        <span className="ml-auto text-dim">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pl-1">
          {r.detail && <p className="text-bad">{r.detail}</p>}
          {r.steps.map((s, i) => (
            <div key={s.id} className="flex gap-3">
              {s.shot ? (
                <a href={shotUrl(t.id, s.shot)} target="_blank" rel="noreferrer" className="shrink-0">
                  <img src={shotUrl(t.id, s.shot)} alt={`step ${i + 1}`} className="h-16 w-28 rounded border border-line object-cover object-top" />
                </a>
              ) : (
                <span className="h-16 w-28 shrink-0 rounded border border-dashed border-line" />
              )}
              <span className="flex min-w-0 flex-col">
                <span className={s.status === 'done' ? 'text-fg' : s.status === 'failed' ? 'text-bad' : 'text-dim'}>
                  {mark[s.status]} {i + 1}. {r.plan.find((p) => p.id === s.id)?.title}
                </span>
                <span className="text-dim">
                  {s.how === 'auto' ? 'seen by mevo' : s.how === 'manual' ? 'marked by the tester' : ''}
                  {s.at ? ` · ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
                {s.detail && <span className="truncate font-mono text-[11px] text-dim">{s.detail}</span>}
                {s.note && <span className="text-fg-2">“{s.note}”</span>}
              </span>
            </div>
          ))}
          {r.txs.length > 0 && <span className="text-dim">Transactions: {r.txs.map((h) => h.slice(0, 12)).join(', ')}</span>}
          {r.errors.length > 0 && (
            <details>
              <summary className="cursor-pointer text-bad">{r.errors.length} console error(s)</summary>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{r.errors.join('\n')}</pre>
            </details>
          )}
          {r.video && (
            <span className="flex flex-wrap gap-3">
              {[r.video, ...(r.videos ?? [])].map((v, i, all) => (
                <a key={v} href={shotUrl(t.id, v)} target="_blank" rel="noreferrer" className="text-accent-fg">
                  {all.length > 1 ? `Watch part ${i + 1}` : r.device ? 'Watch the phone screen' : 'Watch the session'}
                </a>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function StepEditor({ steps, onChange, onSave, onCancel, busy }: { steps: TestStep[]; onChange: (s: TestStep[]) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const set = (i: number, patch: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const input = 'w-full rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  return (
    <div className="flex flex-col gap-2">
      {steps.map((s, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg border border-line px-2 py-2">
          <span className="flex items-center gap-2">
            <span className="text-dim">{i + 1}.</span>
            <input aria-label="step title" className={input} value={s.title} onChange={(e) => set(i, { title: e.target.value })} />
            <button type="button" aria-label="remove step" className="text-dim hover:text-bad" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
              ✕
            </button>
          </span>
          <input aria-label="what to do" placeholder="What to do" className={input} value={s.how} onChange={(e) => set(i, { how: e.target.value })} />
          <input aria-label="what should happen" placeholder="What should happen" className={input} value={s.expect} onChange={(e) => set(i, { expect: e.target.value })} />
          <input aria-label="go to" placeholder="Take me to (a route, e.g. /register/name.eth), optional" className={`${input} font-mono`} value={s.go ?? ''} onChange={(e) => set(i, { go: e.target.value })} />
          <span className="flex gap-2">
            <select aria-label="check" className="rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg" value={s.check.kind} onChange={(e) => set(i, { check: { kind: e.target.value as TestCheckKind, ...(s.check.value ? { value: s.check.value } : {}) } })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {CHECK[k]}
                </option>
              ))}
            </select>
            {s.check.kind !== 'manual' && <input aria-label="check value" placeholder="what to look for" className={input} value={s.check.value ?? ''} onChange={(e) => set(i, { check: { kind: s.check.kind, ...(e.target.value ? { value: e.target.value } : {}) } })} />}
          </span>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => onChange([...steps, { id: `s${steps.length + 1}`, title: 'New step', how: '', expect: '', check: { kind: 'manual' } }])}>
          Add a step
        </Button>
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !steps.length} onClick={onSave}>
            Save steps
          </Button>
        </span>
      </div>
    </div>
  )
}
