import type { LinearSyncRow, MascotStatus, SlackChannel, AskReply, Nudge, AssistAction, BranchUpdateResult, CommentTriage, FixLogView, SlackMention, Leaderboard, PrMeta, OpenPr, ReviewDepth, CiDiagnosis, FindScope, FoundIssue, LinearProject, EngineSetupStatus, CycleView, TodayItem, DaemonState, Effort, Health, LearningProposal, LinearIssueView, MediaFile, PrinciplesUpdate, PrReview, HumanTestRun, PrView, Readiness, LiveLine, TestPlan, TestStep, ServerEvent, Settings, SettingsView, PipelineView, PromptPreview, ReplayView, StepId, VisualPlanView, StartChoice, Ticket, TicketDiff } from '@ticketflow/shared'
import { useCallback, useEffect, useState } from 'react'
import { setLabelColors } from './labels.js'
import { setTriage } from './triage.js'
import { isDesktop } from './tauri.js'

// Served by the daemon: same origin. Inside the desktop shell: the daemon on localhost.
export const API = isDesktop ? 'http://localhost:4747' : ''

export type LiveMap = Readonly<Record<string, readonly LiveLine[]>>
const MAX_LINES = 400

export interface DaemonFeed {
  readonly state: DaemonState | null
  readonly live: LiveMap
  readonly connected: boolean
  // 'stream' = SSE, 'poll' = fetching every few seconds (quick tunnels drop SSE)
  readonly mode: 'stream' | 'poll'
  // the daemon answered 401: the cookie for this tunnel URL is missing or stale
  readonly unauthorized: boolean
  // fetch the whole state again (the Refresh button, coming back to the window)
  readonly reload: () => Promise<void>
}

// Cloudflare quick tunnels do not carry server-sent events, so there the board polls.
const POLL_ONLY = typeof location !== 'undefined' && location.hostname.endsWith('.trycloudflare.com')
const POLL_MS = 3000

export function useDaemon(): DaemonFeed {
  const [state, setState] = useState<DaemonState | null>(null)
  const [live, setLive] = useState<LiveMap>({})
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<'stream' | 'poll'>(POLL_ONLY ? 'poll' : 'stream')
  const [unauthorized, setUnauthorized] = useState(false)

  const addLines = useCallback((items: readonly { id: string; line: LiveLine }[]) => {
    if (items.length === 0) return
    setLive((prev) => {
      const next: Record<string, readonly LiveLine[]> = { ...prev }
      for (const { id, line } of items) next[id] = [...(next[id] ?? []), line].slice(-MAX_LINES)
      return next
    })
  }, [])

  useEffect(() => {
    if (mode !== 'stream') return
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // an SSE that never opens (buffered by a proxy) is as good as down
    const watchdog = setTimeout(() => {
      if (source?.readyState !== EventSource.OPEN) setMode('poll')
    }, 6000)
    const open = () => {
      source = new EventSource(`${API}/api/events`)
      source.onopen = () => {
        failures = 0
        setConnected(true)
        setUnauthorized(false)
      }
      source.onerror = () => {
        setConnected(false)
        source?.close()
        failures += 1
        if (failures >= 2) setMode('poll')
        else retry = setTimeout(open, 2000)
      }
      const pending = new Map<string, Ticket>()
      let frame: number | null = null
      source.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent
        if (event.type === 'snapshot') {
          setState(event.state)
          setLabelColors(event.state.labelColors)
          setTriage(event.state.triage)
        }
        if (event.type === 'labels') setLabelColors(event.labelColors)
        if (event.type === 'triage') setTriage(event.triage)
        if (event.type === 'slack') setState((prev) => (prev ? { ...prev, slackMentions: event.mentions } : prev))
        if (event.type === 'night') setState((prev) => (prev ? { ...prev, nightShift: event.night } : prev))
        if (event.type === 'mascot') setState((prev) => (prev ? { ...prev, mascot: event.mascot } : prev))
        if (event.type === 'ticket') {
          // several tickets in one frame: one render
          pending.set(event.ticket.id, event.ticket)
          frame ??= requestAnimationFrame(() => {
            frame = null
            const batch = Object.fromEntries(pending)
            pending.clear()
            setState((prev) => (prev ? { ...prev, tickets: { ...prev.tickets, ...batch } } : prev))
          })
        }
        if (event.type === 'removed') {
          pending.delete(event.id)
          setState((prev) => {
            if (!prev?.tickets[event.id]) return prev
            const { [event.id]: _gone, ...tickets } = prev.tickets
            return { ...prev, tickets }
          })
        }
        if (event.type === 'review') {
          setState((prev) => (prev ? { ...prev, reviews: { ...prev.reviews, [event.review.id]: event.review } } : prev))
        }
        if (event.type === 'live') addLines([{ id: event.id, line: event.line }])
      }
    }
    open()
    return () => {
      clearTimeout(retry)
      clearTimeout(watchdog)
      source?.close()
    }
  }, [mode, addLines])

  useEffect(() => {
    if (mode !== 'poll') return
    let stopped = false
    let since = new Date(Date.now() - 10 * 60_000).toISOString()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rounds = 0
    const tick = async () => {
      try {
        const res = await fetch(`${API}/api/state`, { cache: 'no-store' })
        if (res.status === 401) {
          setUnauthorized(true)
          setConnected(false)
        } else if (res.ok) {
          const next = (await res.json()) as DaemonState
          setState(next)
          setLabelColors(next.labelColors)
          setTriage(next.triage)
          setConnected(true)
          setUnauthorized(false)
          const lr = await fetch(`${API}/api/live?since=${encodeURIComponent(since)}`, { cache: 'no-store' })
          if (lr.ok) {
            const items = (await lr.json()) as { id: string; line: LiveLine }[]
            const last = items.at(-1)
            if (last) since = last.line.at
            addLines(items)
          }
        } else {
          setConnected(false)
        }
      } catch {
        setConnected(false)
      }
      rounds += 1
      // off the tunnel, try the stream again now and then
      if (!POLL_ONLY && rounds % 20 === 0) {
        setMode('stream')
        return
      }
      if (!stopped) timer = setTimeout(() => void tick(), document.hidden ? POLL_MS * 4 : POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [mode, addLines])

  const reload = useCallback(async () => {
    const res = await fetch(`${API}/api/state`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`the daemon answered ${res.status}`)
    const next = (await res.json()) as DaemonState
    setState(next)
    setLabelColors(next.labelColors)
    setTriage(next.triage)
  }, [])

  // after sleep or a hidden window the stream may have missed events: take a fresh copy
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [reload])

  return { state, live, connected, mode, unauthorized, reload }
}

export function useHealth(intervalMs = 10_000): { readonly health: Health | null; readonly refresh: () => Promise<void> } {
  const [health, setHealth] = useState<Health | null>(null)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/health`)
      setHealth(res.ok ? ((await res.json()) as Health) : null)
    } catch {
      setHealth(null)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), intervalMs)
    return () => clearInterval(id)
  }, [refresh, intervalMs])
  return { health, refresh }
}

export async function loadLive(id: string): Promise<readonly LiveLine[]> {
  const res = await fetch(`${API}/api/tickets/${id}/live`)
  return res.ok ? ((await res.json()) as LiveLine[]) : []
}

export async function loadDiff(id: string): Promise<TicketDiff> {
  const res = await fetch(`${API}/api/tickets/${id}/diff`)
  const body = (await res.json()) as TicketDiff | { error: string }
  if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
  return body
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' })
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T | { error: string }
  if (!res.ok || (body && typeof body === 'object' && 'error' in body)) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export const loadIssue = (id: string) => getJson<LinearIssueView>(`/api/tickets/${id}/issue`)
export const loadPrMeta = (kind: 'ticket' | 'review', id: string) => getJson<PrMeta | null>(kind === 'ticket' ? `/api/tickets/${id}/pr-meta` : `/api/reviews/${id}/meta`)
export const loadLeaderboard = (period: 'week' | 'month', fresh = false) => getJson<Leaderboard>(`/api/leaderboard?period=${period}${fresh ? '&fresh=1' : ''}`)
export const loadMedia = (id: string) => getJson<MediaFile[]>(`/api/tickets/${id}/media`)
export const mediaUrl = (id: string, name: string, at?: string) => `${API}/api/tickets/${id}/media/${encodeURIComponent(name)}${at ? `?v=${encodeURIComponent(at)}` : ''}`
export const loadLearnings = () => getJson<{ lastRunAt: string | null; proposals: LearningProposal[]; rules: string }>('/api/learnings')
export const loadReviewKnowledge = () => getJson<FixLogView>('/api/knowledge/reviews')
export const learnReviews = (prs?: number[]) => post<{ queued: number }>('/api/knowledge/reviews/learn', prs ? { prs } : {})
export const learningActions = {
  run: () => post<{ proposed: number }>('/api/learnings/run'),
  decide: (id: string, approve: boolean, text?: string) => post(`/api/learnings/${id}`, { approve, ...(text ? { text } : {}) }),
  remove: (rule: string) => post('/api/learnings/remove', { rule }),
}
export const loadSettings = () => getJson<SettingsView>('/api/settings')
export const loadPipeline = () => getJson<PipelineView>('/api/pipeline')
export const loadReplays = (id: string) => getJson<ReplayView>(`/api/tickets/${id}/replays`)
export const loadVisualPlan = (id: string) => getJson<VisualPlanView | null>(`/api/tickets/${id}/visual-plan`)
export const loadPrompt = (id: string, step: StepId) => getJson<PromptPreview>(`/api/tickets/${id}/prompt/${step}`)
export const loadToday = () => getJson<TodayItem[]>('/api/today')
export const askMetwo = (question: string, history: { role: 'you' | 'mevo'; text: string }[]) => post<AskReply>('/api/ask', { question, history })
export const runAssist = (actions: AssistAction[]) => post<{ results: { action: AssistAction; ok: boolean; text: string }[] }>('/api/assist/run', { actions })
export const triageNow = (force = false) => post('/api/triage', { force })
export const loadCycle = () => getJson<CycleView>('/api/linear/cycle')
export const findIssues = (scope: FindScope, opts: { q?: string; project?: string; team?: string } = {}) =>
  getJson<FoundIssue[]>(`/api/linear/find?${new URLSearchParams({ scope, ...opts }).toString()}`)
export const loadProjects = (q = '') => getJson<LinearProject[]>(`/api/linear/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`)
export const projectByLink = (link: string) => getJson<{ project: LinearProject | null }>(`/api/linear/project?link=${encodeURIComponent(link)}`)
export const lookupIssue = (ref: string) => getJson<{ issue: FoundIssue | null }>(`/api/linear/lookup?ref=${encodeURIComponent(ref)}`)
export const importIssue = (ref: string, assign: boolean) => post<{ ticket: Ticket }>('/api/linear/import', { ref, assign })
export const assignToMe = (ids: readonly string[]) => post<{ assigned: string[]; failed: { id: string; error: string }[] }>('/api/linear/assign', { ids })
export const screenUrl = (serial: string) => `${API}/api/devices/${encodeURIComponent(serial)}/screen`
export const loadPrView = (id: string) => getJson<PrView>(`/api/tickets/${id}/pr-view`)

async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // plain text error
    }
    throw new Error(message)
  }
  return (text ? JSON.parse(text) : {}) as T
}

export const actions = {
  start: (t: Ticket, lane: StartChoice, engine?: string) => post(`/api/tickets/${t.id}/start`, { lane, ...(engine ? { engine } : {}) }),
  skip: (t: Ticket) => post(`/api/tickets/${t.id}/skip`),
  done: (t: Ticket) => post(`/api/tickets/${t.id}/done`),
  dismiss: (t: Ticket) => post<{ status: string }>(`/api/tickets/${t.id}/dismiss`),
  slackAnnounce: (t: Ticket, channel?: string) => post<{ channel: string }>(`/api/tickets/${t.id}/slack/announce`, channel ? { channel } : {}),
  updateBranches: (ids: string[]) => post<{ results: BranchUpdateResult[] }>('/api/prs/update-from-main', { ids }),
  reopen: (t: Ticket) => post<{ status: string; message: string }>(`/api/tickets/${t.id}/reopen`),
  moveInLinear: (t: Ticket, to: 'qa' | 'done') => post(`/api/tickets/${t.id}/linear`, { to }),
  note: (t: Ticket, text: string) => post(`/api/tickets/${t.id}/note`, { text }),
  checkCi: (t: Ticket) => post<{ ci: CiDiagnosis | null }>(`/api/tickets/${t.id}/ci/check`),
  rerunCi: (t: Ticket) => post<{ runs: number }>(`/api/tickets/${t.id}/ci/rerun`),
  fixCi: (t: Ticket) => post(`/api/tickets/${t.id}/ci/fix`),
  readiness: (t: Ticket) => post<{ readiness: Readiness | null }>(`/api/tickets/${t.id}/readiness`),
  askInLinear: (t: Ticket, text: string) => post<{ url: string | null }>(`/api/tickets/${t.id}/readiness/ask`, { text }),
  triageComments: (t: Ticket, ids: string[]) => post<{ triage: Record<string, CommentTriage> }>(`/api/tickets/${t.id}/comments/triage`, { ids }),
  dismissQuestion: (t: Ticket) => post(`/api/tickets/${t.id}/dismiss-question`),
  principles: (t: Ticket, on: boolean | null) => post(`/api/tickets/${t.id}/principles`, { on }),
  answer: (t: Ticket, text: string) => post(`/api/tickets/${t.id}/answer`, { text }),
  // checking: the local checks run first and it pushes if they pass; force pushes past failed ones
  push: (t: Ticket, force = false) => post<{ result: 'pushed' | 'checking' }>(`/api/tickets/${t.id}/push`, force ? { force: true } : {}),
  localChecks: (t: Ticket) => post(`/api/tickets/${t.id}/local-checks`),
  fixLocalChecks: (t: Ticket) => post(`/api/tickets/${t.id}/local-checks/fix`),
  syncPr: (t: Ticket) => post(`/api/tickets/${t.id}/sync`),
  testPlan: (t: Ticket) => post<{ plan: TestPlan }>(`/api/tickets/${t.id}/test-plan`),
  saveTestPlan: (t: Ticket, steps: TestStep[]) => post<{ plan: TestPlan }>(`/api/tickets/${t.id}/test-plan/save`, { steps }),
  handTest: (t: Ticket, mode: 'mock' | 'preview' | 'chrome', device?: string) => post<{ run: HumanTestRun }>(`/api/tickets/${t.id}/hand-test`, device ? { mode, device } : { mode }),
  phoneInput: (serial: string, e: { type: 'tap'; x: number; y: number } | { type: 'swipe'; x: number; y: number; x2: number; y2: number; ms: number } | { type: 'key'; key: 'back' | 'home' | 'apps' }) => post(`/api/devices/${encodeURIComponent(serial)}/input`, e),
  stopHandTest: (t: Ticket) => post(`/api/tickets/${t.id}/hand-test/stop`),
  ask: (t: Ticket, text: string) => post<{ answer: string; toLane: string | null }>(`/api/tickets/${t.id}/ask`, { text }),
  pullFromGithub: (t: Ticket) => post<{ outcome: string; commits: number; text: string }>(`/api/tickets/${t.id}/pull`),
  tellReviewers: (t: Ticket) => post<{ replied: number; resolved: number; requested: string[]; left: number }>(`/api/tickets/${t.id}/tell-reviewers`),
  // quick: a fresh cheap session, no screenshots or e2e; you check it by hand
  fixComments: (t: Ticket, picks?: { id: string; note?: string }[], quick = false) => post(`/api/tickets/${t.id}/fix-comments`, { ...(picks ? { picks } : {}), quick }),
  quickChecked: (t: Ticket) => post(`/api/tickets/${t.id}/quick-check`),
  replay: (id: string) => post<{ ticket: Ticket }>(`/api/tickets/${id}/replay`),
  deleteReplay: (id: string) => post(`/api/tickets/${id}/replay/delete`),
  ignoreComments: (t: Ticket, ids: string[], reopen = false) => post(`/api/tickets/${t.id}/comments/ignore`, { ids, reopen }),
  draftReply: (t: Ticket, comment: string, hint?: string) => post<{ text: string }>(`/api/tickets/${t.id}/comments/draft`, { comment, hint }),
  replyComment: (t: Ticket, comment: string, body: string) => post<{ url: string | null }>(`/api/tickets/${t.id}/comments/reply`, { comment, body }),
  visualRun: (t: Ticket) => post(`/api/tickets/${t.id}/visual`),
  visualPost: (t: Ticket) => post<{ url: string | null }>(`/api/tickets/${t.id}/visual/post`),
  openClaude: (t: Ticket) => post<{ app: string; resumed: boolean }>(`/api/tickets/${t.id}/open-claude`),
  preview: (t: Ticket) => getJson<{ preview: { url: string; sha: string | null; current: boolean } | null }>(`/api/tickets/${t.id}/preview`),
  previewQa: (t: Ticket, force = false) => post(`/api/tickets/${t.id}/preview-qa`, { force }),
  postPreviewQa: (t: Ticket) => post<{ url: string | null }>(`/api/tickets/${t.id}/preview-qa/post`),
  descOpen: (t: Ticket) => getJson<{ open: number }>(`/api/tickets/${t.id}/pr-desc`),
  descPropose: (t: Ticket, trigger: 'visual' | 'manual') => post(`/api/tickets/${t.id}/pr-desc/propose`, { trigger }),
  descApply: (t: Ticket, input: { accept: string[]; comment: string | null; log: string }) => post<{ url: string | null; applied: number; skipped: number }>(`/api/tickets/${t.id}/pr-desc/apply`, input),
  descDiscard: (t: Ticket) => post(`/api/tickets/${t.id}/pr-desc/discard`),
  workChecks: (t: Ticket) => post(`/api/tickets/${t.id}/checks/work`),
  tickChecks: (t: Ticket, lines: string[]) => post<{ ticked: number }>(`/api/tickets/${t.id}/checks/tick`, { lines }),
  visualOverride: (t: Ticket, value: 'on' | 'off' | null) => post(`/api/tickets/${t.id}/visual/override`, { value }),
  instruct: (t: Ticket, text: string, images: readonly { name: string; data: string }[], quick = false) => post<{ ok: boolean; queued?: boolean }>(`/api/tickets/${t.id}/instruct`, { text, images, quick }),
  cancelQueued: (t: Ticket) => post(`/api/tickets/${t.id}/instruct/cancel`),
  finishChecks: (t: Ticket) => post(`/api/tickets/${t.id}/finish-checks`),
  pauseAfter: (t: Ticket, on: boolean) => post(`/api/tickets/${t.id}/pause-after`, { on }),
  // force: past a size or Greptile limit you set
  ready: (t: Ticket, force = false) => post<{ reviewers: string[] }>(`/api/tickets/${t.id}/ready${force ? '?force=1' : ''}`),
  // quick left out: quick fix when every finding is P2/P3, a full round when there is a P1
  fixGreptile: (t: Ticket, quick?: boolean) => post(`/api/tickets/${t.id}/greptile-fix`, quick === undefined ? {} : { quick }),
  openEditor: (t: Ticket) => post<{ editor: string }>(`/api/tickets/${t.id}/open-editor`),
  stop: (t: Ticket) => post(`/api/tickets/${t.id}/stop`),
  resume: (t: Ticket, opts: { engine?: string; fresh?: boolean } = {}) => post(`/api/tickets/${t.id}/resume`, opts),
  updateMain: (t: Ticket) => post(`/api/tickets/${t.id}/update-main`),
  mergeStart: (t: Ticket) => post<{ files: string[]; editor: string | null }>(`/api/tickets/${t.id}/merge/start`),
  mergeCheck: (t: Ticket) => post<{ left: string[] }>(`/api/tickets/${t.id}/merge/check`),
  mergeFinish: (t: Ticket) => post<{ outcome: 'pushed' | 'committed' }>(`/api/tickets/${t.id}/merge/finish`),
  mergeAbort: (t: Ticket) => post(`/api/tickets/${t.id}/merge/abort`),
}

export const slackActions = {
  check: () => post<SlackMention[]>('/api/slack/mentions/check'),
  summarize: (id: string) => post<SlackMention>(`/api/slack/mentions/${encodeURIComponent(id)}/summarize`),
  reply: (id: string, text: string) => post<{ ts: string }>(`/api/slack/mentions/${encodeURIComponent(id)}/reply`, { text }),
  done: (id: string) => post(`/api/slack/mentions/${encodeURIComponent(id)}/done`),
  doneAll: () => post<{ done: number }>('/api/slack/mentions/done-all'),
  reviewSummary: () => getJson<{ text: string | null }>('/api/slack/review-summary'),
  postReviewSummary: (text: string, channel?: string) => post<{ channel: string }>('/api/slack/review-summary', channel ? { text, channel } : { text }),
  channels: (fresh = false) => getJson<{ channels: SlackChannel[] }>(`/api/slack/channels${fresh ? '?fresh=1' : ''}`),
  setPerson: (login: string, id: string) => post('/api/slack/people', { login, id }),
}

export const mascotActions = {
  coffee: (sips: number) => post<{ mascot: MascotStatus }>('/api/mascot/coffee', { sips }),
  set: (energy: number) => post<{ mascot: MascotStatus }>('/api/mascot/energy', { energy }),
}

export const linearSync = {
  check: () => getJson<{ rows: LinearSyncRow[] }>('/api/linear-sync'),
  fix: (ids?: readonly string[]) => post<{ rows: LinearSyncRow[] }>('/api/linear-sync', ids ? { ids } : {}),
}

export const nightActions = {
  // on / off: your switch · null: back to the schedule and your Slack status
  set: (manual: 'on' | 'off' | null) => post('/api/night-shift', { manual }),
  post: (id: string, text?: string) => post<{ mention: SlackMention }>('/api/night-shift/post', text === undefined ? { id } : { id, text }),
  seen: () => post('/api/night-shift/seen'),
  // a made-up message, as if a teammate wrote it, to see Night Shift work end to end
  test: (text: string, from?: string) => post<{ mention: SlackMention }>('/api/night-shift/test', from ? { text, from } : { text }),
}

export interface NudgeDraft {
  readonly login: string
  readonly slackId: string | null
  readonly name: string
  readonly local: string | null
  readonly offHours: boolean
  readonly text: string
  readonly items: readonly Nudge[]
}
export const nudgeActions = {
  draft: (picks: readonly { id: string; login: string }[]) => post<{ drafts: NudgeDraft[] }>('/api/nudges/draft', { picks }),
  send: (login: string, slackId: string, text: string, ids: readonly string[]) => post('/api/nudges/send', { login, slackId, text, ids }),
}

export const reviewActions = {
  add: (url: string) => post<{ review: PrReview }>('/api/reviews', { url }),
  refresh: () => post('/api/reviews/refresh'),
  start: (id: string, depth?: ReviewDepth) => post(`/api/reviews/${id}/start`, depth ? { depth } : {}),
  open: () => getJson<OpenPr[]>('/api/reviews/open'),
  pick: (number: number, depth: ReviewDepth) => post<{ review: PrReview }>('/api/reviews/pick', { number, depth }),
  stop: (id: string) => post(`/api/reviews/${id}/stop`),
  dismiss: (id: string) => post(`/api/reviews/${id}/dismiss`),
  post: (id: string, input: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; findings: { id: string; body: string }[] }) => post<{ review: PrReview }>(`/api/reviews/${id}/post`, input),
  followUp: (id: string) => post<{ review: PrReview }>(`/api/reviews/${id}/followup`),
  checkFollowUp: (id: string) => post<{ review: PrReview }>(`/api/reviews/${id}/followup/check`),
  resolveThread: (id: string, thread: string) => post<{ review: PrReview }>(`/api/reviews/${id}/threads/${encodeURIComponent(thread)}/resolve`),
  replyThread: (id: string, thread: string, text: string) => post<{ review: PrReview }>(`/api/reviews/${id}/threads/${encodeURIComponent(thread)}/reply`, { text }),
  approve: (id: string, body: string) => post<{ review: PrReview }>(`/api/reviews/${id}/approve`, { body }),
  ping: (id: string, text: string) => post<{ review: PrReview }>(`/api/reviews/${id}/ping`, { text }),
}

export const controls = {
  pause: () => post('/api/control/pause'),
  resume: () => post('/api/control/resume'),
  poll: () => post('/api/control/poll'),
  refresh: () => post('/api/control/refresh'),
  probe: () => post<Health>('/api/control/probe'),
  restartBot: () => post<Health>('/api/control/restart-bot'),
  restartDaemon: () => post('/api/control/restart-daemon'),
  engineSetup: () => getJson<EngineSetupStatus[]>('/api/engines/setup'),
  installEngine: (id: string) => post<{ status: EngineSetupStatus }>(`/api/engines/${id}/install`, { confirm: true }),
  engineTerminal: (id: string, step: 'install' | 'login') => post<{ app: string }>(`/api/engines/${id}/terminal`, { step }),
  testEngine: (id: string) => post<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }>(`/api/engines/${id}/test`),
  githubLogin: () => post('/api/control/github-login'),
  effort: (effort: Effort) => post<Health>('/api/control/effort', { effort }),
  parallel: (n: number) => post<Health>('/api/control/parallel', { n }),
  saveSettings: (patch: Settings) => post<SettingsView>('/api/settings', patch),
  resetSetting: (key: string) => post<SettingsView>('/api/settings/reset', { key }),
  principlesUpdate: () => post<PrinciplesUpdate>('/api/principles/update'),
  revokeSessions: () => post<{ revoked: number }>('/api/control/sessions/revoke'),
  stopAll: (shutdown: boolean) => post<{ stopped: string[]; pending: string }>('/api/control/stop-all', { shutdown }),
}
