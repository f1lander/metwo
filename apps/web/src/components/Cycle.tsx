import type { CycleIssue, CycleView, FoundIssue, LinearProject } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { findIssues, importIssue, loadCycle, loadProjects, lookupIssue, projectByLink, runAssist, triageNow, useHealth } from '../lib/api.js'
import { useBoardIds } from '../lib/estimates.js'
import { href } from '../lib/route.js'
import { useTriage, useTriageMap } from '../lib/triage.js'
import { desktop } from '../lib/tauri.js'
import { Button, ConfirmButton, Label, Pill, TriageChip } from './ui.js'

export const openCycle = () => window.dispatchEvent(new Event('metwo:cycle'))

const PRIORITY_TONE: Record<number, 'bad' | 'warn' | 'neutral'> = { 1: 'bad', 2: 'warn' }
type Tab = 'cycle' | 'backlog' | 'project' | 'search'
type AnyIssue = CycleIssue & Partial<Pick<FoundIssue, 'team' | 'project' | 'cycle' | 'assignee' | 'mine' | 'done'>>

// someone else's ticket: hidden by default, never in Select all, Take over asks first
const othersOwn = (i: AnyIssue) => !!i.assignee && !i.mine

const looksLikeProject = (s: string) => /linear\.app\/[^/\s]+\/project\//.test(s)
const looksLikeRef = (s: string) => /linear\.app\/[^/\s]+\/issue\/|github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|^[A-Za-z][A-Za-z0-9]*-\d+$|^#?\d+$/.test(s.trim())

// Find tickets to work on: the current cycle, the team's backlog, any project, a text search,
// or one issue by its Linear link or id. Take assigns it to you; Track only puts it on the board.
export function CycleSheet() {
  const [open, setOpen] = useState(false)
  // GitHub Issues has no cycles or projects: backlog, search and links only
  const github = useHealth(60_000).health?.tracker?.kind === 'github'
  const [tab, setTab] = useState<Tab>('cycle')
  useEffect(() => {
    if (github && (tab === 'cycle' || tab === 'project')) setTab('backlog')
  }, [github, tab])
  const [cycle, setCycle] = useState<CycleView | null>(null)
  const [list, setList] = useState<readonly FoundIssue[] | null>(null)
  const [projects, setProjects] = useState<readonly LinearProject[] | null>(null)
  const [project, setProject] = useState('')
  const [projectQuery, setProjectQuery] = useState('')
  const projectTimer = useRef<number | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<FoundIssue | null | 'none'>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  // Linear workflow states to show ("Ready", "Todo"…); empty = all
  const [states, setStates] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [showOthers, setShowOthers] = useState(false)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const onBoard = useBoardIds()
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      if (tab === 'cycle') setCycle(await loadCycle())
      else if (tab === 'backlog') setList(await findIssues('backlog'))
      else if (tab === 'project') {
        if (!projects) setProjects(await loadProjects())
        setList(project ? await findIssues('project', { project }) : null)
      } else setList(query.trim().length >= 2 && !looksLikeRef(query) ? await findIssues('search', { q: query.trim() }) : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [tab, project, projects, query])

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('metwo:cycle', show)
    return () => window.removeEventListener('metwo:cycle', show)
  }, [])

  useEffect(() => {
    if (!open) return
    setPicked(new Set())
    setNote(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // lists reload when the tab or the project changes; search waits for you to stop typing
  useEffect(() => {
    if (!open || tab === 'search') return
    setList(null)
    void load()
  }, [open, tab, project]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setFound(null)
      return
    }
    const t = setTimeout(async () => {
      if (looksLikeProject(q)) {
        // a project link: open that project, even an old or closed one
        setFound(null)
        const p = (await projectByLink(q).catch(() => ({ project: null }))).project
        if (!p) {
          setNote('No Linear project found for that link (or the API key cannot see it).')
          return
        }
        setProjects((list) => [p, ...(list ?? []).filter((x) => x.id !== p.id)])
        setTab('project')
        setProject(p.id)
        setQuery('')
        setNote(`Showing ${p.name}.`)
      } else if (looksLikeRef(q)) {
        setFound((await lookupIssue(q).catch(() => ({ issue: null }))).issue ?? 'none')
      } else {
        setFound(null)
        if (tab !== 'search') setTab('search')
        else void load()
      }
    }, 350)
    return () => clearTimeout(t)
  }, [query, open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && tab === 'search') void load()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const done = (ids: readonly string[]) => {
    setCycle((v) => (v ? { ...v, issues: v.issues.filter((i) => !ids.includes(i.id)) } : v))
    setPicked(new Set())
  }

  // from the cycle: the assistant's take (easy ones start on autopilot when it is on);
  // from anywhere else: assigned in Linear and onto the board, whatever team it is in
  const take = async (ids: readonly string[]) => {
    setBusy(true)
    try {
      if (tab === 'cycle') {
        const { results } = await runAssist([{ type: 'take', ids: [...ids] }])
        const r = results[0]
        setNote(r ? (r.ok ? `${r.text}. They are on the board now.` : r.text) : '')
        if (r?.ok) done(ids.filter((id) => r.text.includes(id)))
      } else {
        const ok: string[] = []
        const failed: string[] = []
        for (const id of ids) await importIssue(id, true).then(() => ok.push(id), (e: unknown) => failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`))
        setNote([ok.length ? `${ok.join(', ')} assigned to you and on the board.` : '', ...failed].filter(Boolean).join(' '))
        done(ok)
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const track = async (id: string) => {
    setBusy(true)
    try {
      await importIssue(id, false)
      setNote(`${id} is on the board (not assigned to you in Linear).`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const triage = useTriageMap()
  const order = (i: CycleIssue) => (triage[i.id]?.easy ? 0 : triage[i.id] ? 1 : 2)
  const all: readonly AnyIssue[] = tab === 'cycle' ? [...(cycle?.issues ?? [])].sort((a, b) => order(a) - order(b)) : (list ?? [])
  const others = all.filter(othersOwn).length
  const base = showOthers ? all : all.filter((i) => !othersOwn(i))
  const stateCounts = [...base.reduce((m, i) => m.set(i.state, (m.get(i.state) ?? 0) + 1), new Map<string, number>())]
  const issues = states.size ? base.filter((i) => states.has(i.state)) : base
  const toggleState = (st: string) =>
    setStates((cur) => {
      const next = new Set(cur)
      if (next.has(st)) next.delete(st)
      else next.add(st)
      return next
    })
  const pickable = issues.filter((i) => !onBoard.has(i.id) && !othersOwn(i))
  const easy = tab === 'cycle' ? issues.filter((i) => triage[i.id]?.easy && !othersOwn(i)) : []
  const untriaged = tab === 'cycle' ? issues.filter((i) => !triage[i.id]).length : 0
  const subtitle =
    tab === 'cycle'
      ? cycle?.cycle
        ? `${cycle.cycle.name} · ${issues.length} unassigned · ends ${new Date(cycle.cycle.endsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
        : cycle
          ? 'No active cycle for the team'
          : 'Loading…'
      : tab === 'backlog'
        ? list ? `${list.length} unassigned and open in the team, any cycle` : 'Loading…'
        : tab === 'project'
          ? project ? (list ? `${base.length} open in the project, unassigned or yours` : 'Loading…') : 'Pick a project'
          : list ? `${base.length} match${base.length === 1 ? '' : 'es'}, open or closed` : 'Type at least 2 letters'

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[8vh] backdrop-blur-[2px] max-md:items-end max-md:p-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div
            role="dialog"
            aria-label="Find tickets"
            onMouseDown={(e) => e.stopPropagation()}
            className="flex max-h-[82vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-[0_24px_80px_rgba(0,0,0,.55)] max-md:max-h-[90vh] max-md:rounded-b-none"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 460, damping: 36 }}
          >
            <div className="flex flex-col gap-2.5 border-b border-line px-4 pt-3 pb-2.5">
              <div className="flex items-center gap-2">
                <label htmlFor="find-input" className="sr-only">
                  Search Linear, or paste a link or id
                </label>
                <input
                  id="find-input"
                  ref={input}
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search, or paste a Linear issue or project link · WEB-123 · 123"
                  className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] outline-none transition-colors focus:border-accent max-md:text-[16px]"
                />
                <button type="button" aria-label="close" className="px-1 text-muted hover:text-fg" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              <AnimatePresence initial={false}>
                {found && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    {found === 'none' ? (
                      <div className="rounded-lg border border-line bg-bg px-3 py-2.5 text-xs text-muted">No Linear issue with that id or link (or the API key can't see it).</div>
                    ) : (
                      <div className="rounded-lg border border-accent/50 bg-accent/5">
                        <Row issue={found} picked={false} busy={busy} onBoard={onBoard.has(found.id)} onToggle={() => undefined} onTake={() => void take([found.id])} onTrack={() => void track(found.id)} single />
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex flex-wrap items-center gap-1 text-xs" role="tablist">
                {(
                  [
                    ['cycle', 'Current cycle'],
                    ['backlog', 'Backlog'],
                    ['project', 'Projects'],
                    ['search', 'Search'],
                  ] as const
                )
                  .filter(([k]) => !github || (k !== 'cycle' && k !== 'project'))
                  .map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-2.5 py-1 ${tab === k ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
                    {label}
                  </button>
                ))}
                {tab === 'project' && (
                  <input
                    aria-label="search projects by name"
                    value={projectQuery}
                    onChange={(e) => {
                      const v = e.target.value
                      setProjectQuery(v)
                      window.clearTimeout(projectTimer.current)
                      projectTimer.current = window.setTimeout(() => {
                        void loadProjects(v.trim()).then((list) => setProjects((prev) => [...(prev ?? []).filter((p) => p.id === project), ...list.filter((p) => p.id !== project)]))
                      }, 300)
                    }}
                    placeholder="Find a project…"
                    className="ml-1 w-36 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent max-md:text-[16px]"
                  />
                )}
                {tab === 'project' && (
                  <select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="ml-1 max-w-[260px] rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent">
                    <option value="">{projects ? 'Pick a project…' : 'Loading projects…'}</option>
                    {(projects ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.teams.length ? ` · ${p.teams.join(', ')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {easy.length > 0 && (
                    <button type="button" className="rounded-full border border-[#27463a] bg-[#16281f] px-2.5 py-0.5 text-ok hover:brightness-125" onClick={() => setPicked(new Set(easy.map((i) => i.id)))}>
                      Pick the {easy.length} easy one{easy.length === 1 ? '' : 's'}
                    </button>
                  )}
                  {tab === 'cycle' && (
                    <button type="button" className="text-muted hover:text-fg" onClick={() => void triageNow(untriaged === 0).then(() => setNote('Triaging with AI… sizes appear as they come in.'))}>
                      {untriaged ? `Triage ${untriaged}` : 'Re-triage'}
                    </button>
                  )}
                  <button type="button" className="text-muted hover:text-fg disabled:opacity-50" disabled={loading} onClick={() => void load()}>
                    {loading ? 'Loading…' : 'Refresh'}
                  </button>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-dim">
                <span className="mr-1">{subtitle}</span>
                {others > 0 && (
                  <button type="button" aria-pressed={showOthers} onClick={() => setShowOthers((v) => !v)} className={`rounded-full border px-2 py-0.5 ${showOthers ? 'border-warn/60 text-warn' : 'border-line-2 text-muted hover:text-fg'}`} title="tickets someone else already has in Linear">
                    {showOthers ? `Hide ${others} assigned to others` : `${others} assigned to others hidden · show`}
                  </button>
                )}
                {stateCounts.length > 1 && (
                  <>
                    <button type="button" onClick={() => setStates(new Set())} className={`rounded-full border px-2 py-0.5 ${states.size === 0 ? 'border-accent text-fg' : 'border-line-2 text-muted hover:text-fg'}`}>
                      All {base.length}
                    </button>
                    {stateCounts.map(([st, n]) => (
                      <button key={st} type="button" aria-pressed={states.has(st)} onClick={() => toggleState(st)} className={`rounded-full border px-2 py-0.5 ${states.has(st) ? 'border-accent bg-accent/10 text-fg' : 'border-line-2 text-muted hover:text-fg'}`}>
                        {st} {n}
                      </button>
                    ))}
                  </>
                )}
                {states.size > 0 && stateCounts.length <= 1 && (
                  <button type="button" onClick={() => setStates(new Set())} className="rounded-full border border-accent px-2 py-0.5 text-fg">
                    {[...states].join(', ')} · clear
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {error && <div className="px-4 py-3 text-xs break-words text-bad">{(error.split(': {')[0] ?? error).slice(0, 300)}</div>}
              {tab === 'cycle' && cycle?.cycle && issues.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">Nothing unassigned left in this cycle. Try the Backlog or a project.</div>}
              {tab !== 'cycle' && list && list.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">Nothing here.</div>}
              {tab !== 'cycle' && list && list.length > 0 && base.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">Everything here is assigned to someone else.</div>}
              {states.size > 0 && base.length > 0 && issues.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">Nothing in {[...states].join(' or ')} here.</div>}
              <AnimatePresence initial={false}>
                {issues.map((i) => (
                  <Row key={i.id} issue={i} picked={picked.has(i.id)} busy={busy} onBoard={onBoard.has(i.id)} onToggle={() => toggle(i.id)} onTake={() => void take([i.id])} onTrack={() => void track(i.id)} />
                ))}
              </AnimatePresence>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-md:pb-[calc(env(safe-area-inset-bottom)+12px)]">
              {pickable.length > 0 && (
                <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setPicked(picked.size === pickable.length ? new Set() : new Set(pickable.map((i) => i.id)))}>
                  {picked.size === pickable.length ? 'Clear' : 'Select all'}
                </button>
              )}
              <AnimatePresence>
                {note && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-w-0 flex-1 truncate text-xs text-fg-2" title={note}>
                    {note}
                  </motion.span>
                )}
              </AnimatePresence>
              <Button variant="primary" className="ml-auto" disabled={busy || picked.size === 0} onClick={() => void take([...picked])}>
                {busy ? 'Assigning…' : picked.size ? `Assign ${picked.size} to me` : 'Assign to me'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Row({ issue: i, picked, busy, onBoard, onToggle, onTake, onTrack, single = false }: { issue: AnyIssue; picked: boolean; busy: boolean; onBoard: boolean; onToggle: () => void; onTake: () => void; onTrack: () => void; single?: boolean }) {
  const triage = useTriage(i.id)
  const other = i.assignee && !i.mine ? i.assignee : null
  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: 40, height: 0, transition: { duration: 0.25 } }} className={`group flex items-start gap-3 px-4 py-2.5 ${picked ? 'bg-raised' : single ? '' : 'hover:bg-raised/60'}`}>
      {!single && <input type="checkbox" checked={picked} disabled={onBoard || !!other} onChange={onToggle} aria-label={`select ${i.id}`} className="mt-1 size-3.5 shrink-0 accent-[var(--color-accent)] disabled:opacity-30" />}
      <button type="button" onClick={single || onBoard || other ? undefined : onToggle} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{i.id}</span>
          {i.priority > 0 && <Pill tone={PRIORITY_TONE[i.priority] ?? 'neutral'}>{i.priorityLabel}</Pill>}
          <span>{i.state}</span>
          {i.estimate !== null && <span>· {i.estimate} pt</span>}
          {i.project && <span className="text-fg-2">· {i.project}</span>}
          {i.cycle && <span>· {i.cycle}</span>}
          {i.labels.slice(0, 3).map((l) => (
            <Label key={l} name={l} />
          ))}
          <TriageChip triage={triage} />
        </div>
        <div className="mt-0.5 text-[13px] leading-snug">{i.title}</div>
        {(other || i.mine) && <div className={`mt-0.5 text-[11px] ${other ? 'text-warn' : 'text-dim'}`}>{i.mine ? 'assigned to you' : `assigned to ${other}`}</div>}
        {triage?.why && <div className="mt-0.5 text-[11px] leading-snug text-dim">{triage.why}</div>}
      </button>
      <div className={`flex shrink-0 items-center gap-2 ${single ? '' : 'opacity-70 group-hover:opacity-100 max-md:opacity-100'}`}>
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void desktop.open(i.url)}>
          Open
        </button>
        {onBoard ? (
          <a href={href.ticket(i.id)} className="text-xs text-accent-fg hover:underline">
            On the board →
          </a>
        ) : (
          <>
            {(other || i.done) && (
              <Button variant="ghost" disabled={busy} title="puts it on the board without changing who it is assigned to" onClick={onTrack}>
                Track
              </Button>
            )}
            {!i.done && other && <ConfirmButton label="Take over" confirm={`Take it from ${other}`} disabled={busy} onConfirm={onTake} />}
            {!i.done && !other && (
              <Button disabled={busy} title="assigns it to you in Linear and puts it on the board" onClick={onTake}>
                {i.mine ? 'Add' : 'Take'}
              </Button>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}
