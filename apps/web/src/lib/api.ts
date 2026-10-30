import type { AskReply, AssistAction, CycleView, TodayItem, DaemonState, Effort, Health, LearningProposal, LinearIssueView, MediaFile, PrReview, PrView, LiveLine, ServerEvent, Settings, SettingsView, StartChoice, Ticket, TicketDiff } from '@ticketflow/shared'
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
      source.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent
        if (event.type === 'snapshot') {
          setState(event.state)
          setLabelColors(event.state.labelColors)
          setTriage(event.state.triage)
        }
        if (event.type === 'labels') setLabelColors(event.labelColors)
        if (event.type === 'triage') setTriage(event.triage)
        if (event.type === 'ticket') {
          setState((prev) => (prev ? { ...prev, tickets: { ...prev.tickets, [event.ticket.id]: event.ticket } } : prev))
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
export const loadMedia = (id: string) => getJson<MediaFile[]>(`/api/tickets/${id}/media`)
export const mediaUrl = (id: string, name: string, at?: string) => `${API}/api/tickets/${id}/media/${encodeURIComponent(name)}${at ? `?v=${encodeURIComponent(at)}` : ''}`
export const loadLearnings = () => getJson<{ lastRunAt: string | null; proposals: LearningProposal[]; rules: string }>('/api/learnings')
export const learningActions = {
  run: () => post<{ proposed: number }>('/api/learnings/run'),
  decide: (id: string, approve: boolean, text?: string) => post(`/api/learnings/${id}`, { approve, ...(text ? { text } : {}) }),
  remove: (rule: string) => post('/api/learnings/remove', { rule }),
}
export const loadSettings = () => getJson<SettingsView>('/api/settings')
export const loadToday = () => getJson<TodayItem[]>('/api/today')
export const askMetwo = (question: string, history: { role: 'you' | 'metwo'; text: string }[]) => post<AskReply>('/api/ask', { question, history })
export const runAssist = (actions: AssistAction[]) => post<{ results: { action: AssistAction; ok: boolean; text: string }[] }>('/api/assist/run', { actions })
export const triageNow = (force = false) => post('/api/triage', { force })
export const loadCycle = () => getJson<CycleView>('/api/linear/cycle')
export const assignToMe = (ids: readonly string[]) => post<{ assigned: string[]; failed: { id: string; error: string }[] }>('/api/linear/assign', { ids })
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
  moveInLinear: (t: Ticket, to: 'qa' | 'done') => post(`/api/tickets/${t.id}/linear`, { to }),
  note: (t: Ticket, text: string) => post(`/api/tickets/${t.id}/note`, { text }),
  answer: (t: Ticket, text: string) => post(`/api/tickets/${t.id}/answer`, { text }),
  push: (t: Ticket) => post(`/api/tickets/${t.id}/push`),
  fixComments: (t: Ticket, picks?: { id: string; note?: string }[]) => post(`/api/tickets/${t.id}/fix-comments`, picks ? { picks } : {}),
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
  visualOverride: (t: Ticket, value: 'on' | 'off' | null) => post(`/api/tickets/${t.id}/visual/override`, { value }),
  instruct: (t: Ticket, text: string, images: readonly { name: string; data: string }[]) => post<{ ok: boolean; queued?: boolean }>(`/api/tickets/${t.id}/instruct`, { text, images }),
  cancelQueued: (t: Ticket) => post(`/api/tickets/${t.id}/instruct/cancel`),
  pauseAfter: (t: Ticket, on: boolean) => post(`/api/tickets/${t.id}/pause-after`, { on }),
  ready: (t: Ticket) => post<{ reviewers: string[] }>(`/api/tickets/${t.id}/ready`),
  fixGreptile: (t: Ticket) => post(`/api/tickets/${t.id}/greptile-fix`),
  openEditor: (t: Ticket) => post<{ editor: string }>(`/api/tickets/${t.id}/open-editor`),
  stop: (t: Ticket) => post(`/api/tickets/${t.id}/stop`),
  resume: (t: Ticket) => post(`/api/tickets/${t.id}/resume`),
  updateMain: (t: Ticket) => post(`/api/tickets/${t.id}/update-main`),
}

export const reviewActions = {
  add: (url: string) => post<{ review: PrReview }>('/api/reviews', { url }),
  refresh: () => post('/api/reviews/refresh'),
  start: (id: string) => post(`/api/reviews/${id}/start`),
  stop: (id: string) => post(`/api/reviews/${id}/stop`),
  dismiss: (id: string) => post(`/api/reviews/${id}/dismiss`),
  post: (id: string, input: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; findings: { id: string; body: string }[] }) => post<{ review: PrReview }>(`/api/reviews/${id}/post`, input),
}

export const controls = {
  pause: () => post('/api/control/pause'),
  resume: () => post('/api/control/resume'),
  poll: () => post('/api/control/poll'),
  refresh: () => post('/api/control/refresh'),
  probe: () => post<Health>('/api/control/probe'),
  restartBot: () => post<Health>('/api/control/restart-bot'),
  testEngine: (id: string) => post<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }>(`/api/engines/${id}/test`),
  githubLogin: () => post('/api/control/github-login'),
  effort: (effort: Effort) => post<Health>('/api/control/effort', { effort }),
  parallel: (n: number) => post<Health>('/api/control/parallel', { n }),
  saveSettings: (patch: Settings) => post<SettingsView>('/api/settings', patch),
  resetSetting: (key: string) => post<SettingsView>('/api/settings/reset', { key }),
  stopAll: (shutdown: boolean) => post<{ stopped: string[]; pending: string }>('/api/control/stop-all', { shutdown }),
}
