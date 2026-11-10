// Linear vs GitHub: where each ticket should be in Linear given its PR. Only ever moves forward.
export type PrPhase = 'draft' | 'open' | 'merged'

export interface LinearSyncRow {
  readonly id: string
  readonly title: string
  readonly number: number
  readonly url: string
  readonly pr: PrPhase
  readonly linear: string
  // the state it should move to; null when it already matches
  readonly want: string | null
  // the PR is attached to the Linear issue
  readonly linked: boolean
  readonly error?: string
}

export interface SyncStates {
  readonly inProgress: string
  readonly inReview: string
  readonly qa: string
  readonly done: string
}

// type: Linear's state type (backlog, unstarted, started, completed, canceled, triage)
export function syncWant(pr: PrPhase, name: string, type: string, s: SyncStates): string | null {
  if (type === 'completed' || type === 'canceled') return null
  const at = name.toLowerCase()
  const is = (x: string) => at === x.toLowerCase()
  if (pr === 'merged') return is(s.qa) ? null : s.done
  if (pr === 'open') return is(s.inReview) || is(s.qa) ? null : s.inReview
  return type === 'started' ? null : s.inProgress
}
