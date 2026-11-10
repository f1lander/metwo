import { buildHistory, estimateFor, type Estimate, type History, type StartChoice, type Ticket } from '@ticketflow/shared'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTriageMap } from './triage.js'

// Run history from every ticket the daemon knows, rebuilt when the ticket list changes.
let tickets: readonly Ticket[] = []
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setTickets(next: readonly Ticket[]): void {
  if (next === tickets) return
  tickets = next
  for (const l of listeners) l()
}

// One history for every card: built once per ticket list, not once per card that asks
let cached: { all: unknown; triage: unknown; history: History } | null = null
export function useHistory(): History {
  const all = useSyncExternalStore(subscribe, () => tickets)
  const triage = useTriageMap()
  if (cached?.all !== all || cached.triage !== triage) cached = { all, triage, history: buildHistory(all, triage) }
  return cached.history
}

export type Estimates = Readonly<Record<StartChoice, Estimate | null>>

export function useEstimates(t: Pick<Ticket, 'id' | 'labels'>): Estimates {
  const history = useHistory()
  const triage = useTriageMap()[t.id]
  return useMemo(
    () => ({ lite: estimateFor(history, t, 'lite', triage), full: estimateFor(history, t, 'full', triage), max: estimateFor(history, t, 'max', triage) }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: labels are compared by value
    [history, t.id, t.labels.join(','), triage],
  )
}

// The lane this ticket runs (or would run) on.
export const laneOf = (t: Ticket): StartChoice => (t.maxEffort ? 'max' : (t.lane ?? t.suggestedLane))

// A clock for elapsed times and the live spend estimate.
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

// Ask before starting a ticket estimated over these (per viewer; off with `enabled: false`).
export interface ConfirmRule {
  readonly enabled: boolean
  readonly minutes: number
  readonly usd: number
}
const KEY = 'metwo.confirmStart'
export function readConfirmRule(): ConfirmRule {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { enabled: true, minutes: 30, usd: 3, ...(JSON.parse(raw) as Partial<ConfirmRule>) }
  } catch {
    // storage blocked: defaults
  }
  return { enabled: true, minutes: 30, usd: 3 }
}
export function writeConfirmRule(rule: ConfirmRule): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rule))
  } catch {
    // storage blocked: kept for this page only
  }
}

export const SENSITIVE = /security|protocol|contract|auth|payment|wallet|migration/i

// ids of the tickets on the board, for "already on the board" in the find sheet
export function useBoardIds(): ReadonlySet<string> {
  const all = useSyncExternalStore(subscribe, () => tickets)
  return useMemo(() => new Set(all.map((t) => t.id)), [all])
}
