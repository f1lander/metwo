import type { BudgetLevel, BudgetStatus, Effort, Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { Store } from './store.js'

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1).getTime()
const pad = (n: number) => String(n).padStart(2, '0')

// Every cost the CLIs reported since `from`: lane turns, review passes, visual checks, PR reviews.
export function spendSince(store: Store, from: number): number {
  let total = 0
  const add = (journal: Ticket['journal']) => {
    for (const j of journal ?? []) if (Date.parse(j.at) >= from) total += Number(j.meta?.cost) || 0
  }
  for (const t of store.all()) add(t.journal)
  for (const r of store.reviews()) add(r.journal)
  for (const s of store.snapshot().spend ?? []) if (Date.parse(s.at) >= from) total += s.cost
  return Math.round(total * 100) / 100
}

export function periodKeys(now = new Date()): { day: string; month: string } {
  return { day: `day:${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, month: `month:${now.getFullYear()}-${pad(now.getMonth() + 1)}` }
}

// The fallback engine for new lanes once the budget is used up: a flat-plan or free engine.
export function fallbackEngine(cfg: Config, enabled: readonly string[]): string | null {
  const pick = cfg.budget.fallback
  if (pick === 'off') return null
  if (pick === 'auto') return ['codex', 'cursor', 'opencode', 'hermes'].find((e) => enabled.includes(e)) ?? null
  return enabled.includes(pick.split(':')[0] ?? '') ? pick : null
}

export function budgetStatus(cfg: Config, store: Store, enabled: readonly string[], now = new Date()): BudgetStatus {
  const day = { spent: spendSince(store, dayStart(now)), limit: cfg.budget.daily }
  const month = { spent: spendSince(store, monthStart(now)), limit: cfg.budget.monthly }
  const share = Math.max(day.limit ? day.spent / day.limit : 0, month.limit ? month.spent / month.limit : 0)
  const level: BudgetLevel = share >= 1 ? 'over' : share >= 0.9 ? 'tight' : share >= 0.6 ? 'saver' : 'normal'
  return { level, regulate: cfg.budget.regulate, day, month, fallback: fallbackEngine(cfg, enabled) }
}

const ORDER: readonly Effort[] = ['low', 'medium', 'high']

// How hard a fresh lane thinks under the current budget: saver caps at medium, tight and over
// run lite on low and full on medium. A ticket you started with max keeps max.
export function regulatedEffort(effort: Effort, lane: 'lite' | 'full', level: BudgetLevel): Effort {
  const cap: Effort = level === 'normal' ? 'high' : level === 'saver' ? 'medium' : lane === 'lite' ? 'low' : 'medium'
  return ORDER[Math.min(ORDER.indexOf(effort), ORDER.indexOf(cap))] as Effort
}

// The alert thresholds crossed since the last one sent, per period.
export function newAlerts(status: BudgetStatus, sent: Readonly<Record<string, number>>, now = new Date()): { key: string; pct: number; label: string; spent: number; limit: number }[] {
  const keys = periodKeys(now)
  const out: { key: string; pct: number; label: string; spent: number; limit: number }[] = []
  for (const [key, label, p] of [
    [keys.day, 'today', status.day],
    [keys.month, 'this month', status.month],
  ] as const) {
    const limit = p.limit
    if (!limit) continue
    const pct = [100, 80, 50].find((x) => p.spent / limit >= x / 100)
    if (pct && pct > (sent[key] ?? 0)) out.push({ key, pct, label, spent: p.spent, limit })
  }
  return out
}
