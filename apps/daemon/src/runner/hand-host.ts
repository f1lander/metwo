import type { JournalEntry, PrReview, Ticket } from '@ticketflow/shared'
import type { Store } from '../store.js'

// What the hand test needs from the store. Tickets come as they are; a review (PR-123) comes as a
// ticket-shaped view of it, so you test a teammate's PR with the same steps panel and wallet.
export type HandStore = Pick<Store, 'get' | 'patch' | 'journal' | 'spend' | 'all'>

const isReview = (id: string) => /^PR-\d+$/.test(id)

export function reviewAsTicket(r: PrReview): Ticket {
  return {
    id: r.id,
    uuid: '',
    title: r.title,
    description: r.body,
    url: r.url,
    branch: r.head,
    labels: [],
    priority: 0,
    estimate: null,
    createdBy: r.author,
    linearState: '',
    seenAt: r.requestedAt,
    updatedAt: r.updatedAt,
    status: 'review_ready',
    decision: 'manual',
    suggestedLane: 'lite',
    reason: '',
    small: false,
    events: [],
    ...(r.worktree ? { worktree: r.worktree } : {}),
    ...(r.port ? { port: r.port } : {}),
    ...(r.testPlan ? { testPlan: r.testPlan } : {}),
    ...(r.humanTests ? { humanTests: r.humanTests } : {}),
    ...(r.journal ? { journal: r.journal } : {}),
  } as Ticket
}

export function handStore(store: Store): HandStore {
  return {
    get: (id) => {
      if (!isReview(id)) return store.get(id)
      const r = store.review(id)
      return r ? reviewAsTicket(r) : undefined
    },
    all: () => [...store.all(), ...store.reviews().filter((r) => r.humanTests?.length).map(reviewAsTicket)],
    patch: (id, changes, event) => {
      if (!isReview(id)) return store.patch(id, changes, event)
      const keep = { ...(changes.testPlan !== undefined ? { testPlan: changes.testPlan } : {}), ...(changes.humanTests !== undefined ? { humanTests: changes.humanTests } : {}) }
      return reviewAsTicket(store.patchReview(id, keep))
    },
    journal: (id, entry: Omit<JournalEntry, 'at'>) => {
      if (!isReview(id)) return store.journal(id, entry)
      return store.review(id) ? reviewAsTicket(store.patchReview(id, {}, entry)) : undefined
    },
    spend: (what, cost) => store.spend(what, cost),
  }
}
