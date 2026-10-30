import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DaemonState, JournalEntry, PrReview, Settings, Ticket, TicketEvent } from '@ticketflow/shared'

// JSON file state. Good enough for one dev and a few dozen tickets; swap for sqlite later.
export class Store extends EventEmitter {
  private state: DaemonState
  private readonly file: string

  constructor(dataDir: string) {
    super()
    mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'state.json')
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as DaemonState)
      : { tickets: {}, nextPortIndex: 0 }
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
    return this.upsert({ ...current, ...changes, events })
  }

  journal(id: string, entry: Omit<JournalEntry, 'at'>): Ticket | undefined {
    const current = this.state.tickets[id]
    if (!current) return undefined
    const journal = [...(current.journal ?? []), { ...entry, at: new Date().toISOString() }]
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
    return this.putReview({ ...current, ...changes, ...(journal ? { journal } : {}) })
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

  private persist(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function deepMerge(base: object, over: object): object {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as object, v) : v
  return out
}
