import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { History } from './history.js'
import type { ChangeRequest, DaemonState, JournalEntry, PrReview, Settings, Ticket, TicketEvent, Triage, SlackMention, NightShiftState, MascotStatus } from '@ticketflow/shared'

// JSON file state. Good enough for one dev and a few dozen tickets; swap for sqlite later.
export class Store extends EventEmitter {
  private state: DaemonState
  private readonly file: string
  readonly history: History

  constructor(dataDir: string) {
    super()
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.file = path.join(dataDir, 'state.json')
    this.history = new History(dataDir)
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as DaemonState)
      : { tickets: {}, nextPortIndex: 0 }
  }

  // Closed tickets older than `days` keep a slim copy on the board; the full record goes to
  // data/archive/<id>.json. Their PR comes back in full from GitHub if it is reopened.
  compactClosed(days = 3, now = Date.now()): string[] {
    const dir = path.join(path.dirname(this.file), 'archive')
    const done: string[] = []
    for (const t of Object.values(this.state.tickets)) {
      if ((t.status !== 'done' && t.status !== 'skipped') || t.archived || now - Date.parse(t.updatedAt) < days * 86_400_000) continue
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, `${t.id}.json`), JSON.stringify(t), { mode: 0o600 })
      const { conversation: _c, commentTriage: _t, ci: _ci, previewQa: _q, testPlan: _p, humanTests: _h, localChecks: _l, quickCheck: _k, unpushed: _u, ...rest } = t
      const slim: Ticket = {
        ...rest,
        archived: new Date(now).toISOString(),
        journal: (t.journal ?? []).map(({ body: _b, ...j }) => j),
        ...(t.pr ? { pr: { ...t.pr, comments: [], body: '', ...(t.pr.greptile ? { greptile: { ...t.pr.greptile, findings: [] } } : {}) } } : {}),
      }
      this.state = { ...this.state, tickets: { ...this.state.tickets, [t.id]: slim } }
      done.push(t.id)
    }
    if (done.length) {
      this.persist()
      for (const id of done) this.emit('ticket', this.state.tickets[id])
    }
    return done
  }

  // the full record of an archived ticket (the board keeps a slim copy)
  archivedRecord(id: string): Ticket | undefined {
    const file = path.join(path.dirname(this.file), 'archive', `${path.basename(id)}.json`)
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Ticket) : undefined
    } catch {
      return undefined
    }
  }

  // gone from the board and the state (replays you delete)
  remove(id: string): void {
    if (!this.state.tickets[id]) return
    const { [id]: _gone, ...tickets } = this.state.tickets
    this.state = { ...this.state, tickets }
    this.persist()
    this.emit('removed', id)
  }

  snapshot(): DaemonState {
    return this.state
  }

  get(id: string): Ticket | undefined {
    return this.state.tickets[id]
  }

  all(): readonly Ticket[] {
    return Object.values(this.state.tickets).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  byStatus(...statuses: readonly Ticket['status'][]): readonly Ticket[] {
    return this.all().filter((t) => statuses.includes(t.status))
  }

  upsert(ticket: Ticket): Ticket {
    const next = { ...ticket, updatedAt: new Date().toISOString() }
    this.state = { ...this.state, tickets: { ...this.state.tickets, [ticket.id]: next } }
    this.persist()
    this.emit('ticket', next)
    return next
  }

  patch(id: string, changes: Partial<Ticket>, event?: Omit<TicketEvent, 'at'>): Ticket {
    const current = this.state.tickets[id]
    if (!current) throw new Error(`unknown ticket ${id}`)
    const events = event
      ? [...current.events, { ...event, at: new Date().toISOString() }]
      : current.events
    if (event) this.history.record({ type: 'event', ticket: id, kind: event.kind, message: event.message })
    if (changes.status && changes.status !== current.status) {
      this.history.record({ type: 'status', ticket: id, from: current.status, to: changes.status, lane: changes.lane ?? current.lane ?? null, engine: changes.engine ?? current.engine ?? null, labels: current.labels })
      if (changes.status === 'done' || changes.status === 'skipped') this.emit('closed', id)
    }
    return this.upsert({ ...current, ...changes, events })
  }

  journal(id: string, entry: Omit<JournalEntry, 'at'>): Ticket | undefined {
    const current = this.state.tickets[id]
    if (!current) return undefined
    const journal = [...(current.journal ?? []), { ...entry, at: new Date().toISOString() }]
    this.emit('journal', id, entry)
    this.history.record({ type: 'journal', ticket: id, kind: entry.kind, title: entry.title, ...(entry.meta ? { meta: entry.meta } : {}), ...(entry.body ? { body: entry.body.slice(0, 2000) } : {}) })
    return this.upsert({ ...current, journal })
  }

  review(id: string): PrReview | undefined {
    return this.state.reviews?.[id]
  }

  reviews(): readonly PrReview[] {
    return Object.values(this.state.reviews ?? {}).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
  }

  putReview(review: PrReview): PrReview {
    const next = { ...review, updatedAt: new Date().toISOString() }
    this.state = { ...this.state, reviews: { ...this.state.reviews, [review.id]: next } }
    this.persist()
    this.emit('review', next)
    return next
  }

  patchReview(id: string, changes: Partial<PrReview>, note?: Omit<JournalEntry, 'at'>): PrReview {
    const current = this.state.reviews?.[id]
    if (!current) throw new Error(`unknown review ${id}`)
    const journal = note ? [...(current.journal ?? []), { ...note, at: new Date().toISOString() }] : current.journal
    if (note || (changes.status && changes.status !== current.status)) this.history.record({ type: 'review', review: id, ...(changes.status ? { status: changes.status } : {}), ...(note ? { title: note.title, ...(note.meta ? { meta: note.meta } : {}) } : {}) })
    return this.putReview({ ...current, ...changes, ...(journal ? { journal } : {}) })
  }

  spend(what: string, cost: number): void {
    const list = [...(this.state.spend ?? []), { at: new Date().toISOString(), what, cost: Number(cost.toFixed(4)) }].slice(-1000)
    this.history.record({ type: 'spend', what, cost: Number(cost.toFixed(4)) })
    this.state = { ...this.state, spend: list }
    this.persist()
  }

  slackMentions(): readonly SlackMention[] {
    return this.state.slackMentions ?? []
  }

  // newest first, the last 100 kept
  // every open mention to done, in one write
  doneAllMentions(): number {
    const list = this.state.slackMentions ?? []
    const open = list.filter((m) => m.status !== 'done').length
    if (!open) return 0
    const next = list.map((m) => (m.status === 'done' ? m : { ...m, status: 'done' as const }))
    this.state = { ...this.state, slackMentions: next }
    this.persist()
    this.emit('slack', next)
    return open
  }

  putSlackMention(m: SlackMention): SlackMention {
    const rest = (this.state.slackMentions ?? []).filter((x) => x.id !== m.id)
    const list = [m, ...rest].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 100)
    this.state = { ...this.state, slackMentions: list }
    this.persist()
    this.emit('slack', list)
    return m
  }

  requests(): readonly ChangeRequest[] {
    return this.state.requests ?? []
  }

  // newest first; closed ones older than a week drop off
  putRequest(r: ChangeRequest): ChangeRequest {
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const rest = (this.state.requests ?? []).filter((x) => x.id !== r.id && (x.status === 'new' || x.status === 'sent' || x.status === 'addressed' || x.updatedAt > week))
    const list = [r, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300)
    this.state = { ...this.state, requests: list }
    this.persist()
    this.emit('requests', list)
    return r
  }

  patchRequest(id: string, patch: Partial<ChangeRequest>): ChangeRequest {
    const r = this.requests().find((x) => x.id === id)
    if (!r) throw new Error(`no request ${id}`)
    return this.putRequest({ ...r, ...patch, updatedAt: new Date().toISOString() })
  }

  requestSeen(): ReadonlySet<string> {
    return new Set(this.state.requestSeen ?? [])
  }

  markRequestSeen(keys: readonly string[], baseline?: string): void {
    if (!keys.length && !baseline) return
    const seen = [...(this.state.requestSeen ?? []), ...keys].slice(-4000)
    const base = baseline ? [...new Set([...(this.state.requestBaseline ?? []), baseline])].slice(-1000) : this.state.requestBaseline
    this.state = { ...this.state, requestSeen: seen, ...(base ? { requestBaseline: base } : {}) }
    this.persist()
  }

  baselined(ticketId: string): boolean {
    return (this.state.requestBaseline ?? []).includes(ticketId)
  }

  mascot(): MascotStatus {
    return this.state.mascot ?? { energy: 1, enabled: true, coffee: true }
  }

  setMascot(patch: Partial<MascotStatus>): MascotStatus {
    const next = { ...this.mascot(), ...patch }
    this.state = { ...this.state, mascot: next }
    this.persist()
    this.emit('mascot', next)
    return next
  }

  nightShift(): NightShiftState {
    return this.state.nightShift ?? { active: false, since: null, reason: null, manual: null, handoff: null }
  }

  setNightShift(patch: Partial<NightShiftState>): NightShiftState {
    const next = { ...this.nightShift(), ...patch }
    this.state = { ...this.state, nightShift: next }
    this.persist()
    this.emit('night', next)
    return next
  }

  setTriage(entries: Readonly<Record<string, Triage>>): void {
    this.state = { ...this.state, triage: { ...(this.state.triage ?? {}), ...entries } }
    this.persist()
    this.emit('triage', this.state.triage)
  }

  // Label colors as Linear has them; only emitted when something new shows up.
  setLabelColors(colors: Readonly<Record<string, string>>): void {
    const current = this.state.labelColors ?? {}
    if (Object.entries(colors).every(([k, v]) => current[k] === v)) return
    this.state = { ...this.state, labelColors: { ...current, ...colors } }
    this.persist()
    this.emit('labels', this.state.labelColors)
  }

  setSettings(changes: Settings): void {
    this.state = { ...this.state, settings: deepMerge(this.state.settings ?? {}, changes) as Settings }
    this.history.record({ type: 'settings', set: changes })
    this.persist()
    this.emit('settings', this.state.settings)
  }

  // Back to the config file's value for one setting ("budget.daily", "autopilot").
  resetSetting(key: string): void {
    const next = structuredClone(this.state.settings ?? {}) as Record<string, unknown>
    const parts = key.split('.')
    let node: Record<string, unknown> | undefined = next
    for (const p of parts.slice(0, -1)) node = node?.[p] as Record<string, unknown> | undefined
    if (node) delete node[parts.at(-1) as string]
    this.history.record({ type: 'settings', reset: key })
    this.state = { ...this.state, settings: next as Settings }
    this.persist()
    this.emit('settings', this.state.settings)
  }

  allocatePort(base: number): number {
    const index = this.state.nextPortIndex
    this.state = { ...this.state, nextPortIndex: index + 1 }
    this.persist()
    return base + index
  }

  // Written at most every 500ms (the file is megabytes; patches come in bursts), and at exit
  private timer: ReturnType<typeof setTimeout> | null = null
  private exitHook = false
  private persist(): void {
    if (!this.exitHook) {
      this.exitHook = true
      process.on('exit', () => this.flush())
    }
    this.timer ??= setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function deepMerge(base: object, over: object): object {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as object, v) : v
  return out
}
