import type { FoundIssue } from '@ticketflow/shared'
import type { Store } from './store.js'

// Not started yet and no longer yours in Linear (unassigned, given to someone else, canceled or done
// there): off the board, to Closed, where Reopen brings it back. Tickets you added by link without
// taking them stay. Each missing one is checked in Linear first (at most every 5 minutes), so a
// state move alone keeps it.
export function makeDropUnassigned(store: Store, lookup: (id: string) => Promise<{ found: FoundIssue } | null>, say: (m: string) => void) {
  const checkedAt = new Map<string, number>()
  return async (seen: ReadonlySet<string>): Promise<void> => {
    const gone = store
      .byStatus('assigned')
      .filter((t) => !seen.has(t.id) && !t.worktree && !t.events[0]?.message.startsWith('added by link') && Date.now() - (checkedAt.get(t.id) ?? 0) > 5 * 60_000)
      .slice(0, 10)
    for (const t of gone) {
      checkedAt.set(t.id, Date.now())
      const got = await lookup(t.id).catch(() => undefined)
      if (got === undefined) continue
      const why = !got ? 'not found in Linear any more' : got.found.done ? 'closed in Linear' : !got.found.mine ? (got.found.assignee ? `assigned to ${got.found.assignee} in Linear` : 'unassigned in Linear') : null
      if (!why) continue
      store.patch(t.id, { status: 'skipped' }, { kind: 'decision', message: `${why}; off the board` })
      say(`${t.id}: ${why}, off the board`)
    }
  }
}
