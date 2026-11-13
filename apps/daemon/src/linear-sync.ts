import { type LinearSyncRow, type PrPhase, syncWant, type Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { Tracker } from './tracker.js'
import type { Store } from './store.js'

// github.com/o/r/pull/12 and github.com/o/r/pull/12/files are the same PR
const samePr = (a: string, b: string) => a.replace(/(\/pull\/\d+).*$/, '$1').toLowerCase() === b.replace(/(\/pull\/\d+).*$/, '$1').toLowerCase()

const phase = (t: Ticket): PrPhase | null => (!t.pr || t.pr.state === 'CLOSED' ? null : t.pr.state === 'MERGED' ? 'merged' : t.pr.isDraft ? 'draft' : 'open')

// Your button for when Linear's GitHub integration missed a PR: compare, then move what's behind
// and attach the PRs the issues don't show.
export class LinearSync {
  constructor(
    private readonly cfg: () => Config,
    private readonly linear: Pick<Tracker, 'states' | 'moveToState' | 'linkPr'>,
    private readonly store: Pick<Store, 'all' | 'get' | 'patch' | 'journal'>,
  ) {}

  async check(): Promise<LinearSyncRow[]> {
    const withPr = this.store.all().filter((t) => phase(t) && t.uuid)
    const states = await this.linear.states(withPr.map((t) => t.uuid))
    const s = this.cfg().linear.states
    return withPr.flatMap((t) => {
      const st = states.get(t.uuid)
      if (!st || !t.pr) return []
      if (st.name !== t.linearState) this.store.patch(t.id, { linearState: st.name })
      const pr = phase(t) as PrPhase
      const linked = st.links.some((l) => samePr(l, t.pr!.url))
      return [{ id: t.id, title: t.title, number: t.pr.number, url: t.pr.url, pr, linear: st.name, want: syncWant(pr, st.name, st.type, s), linked }]
    })
  }

  // moves the given tickets (or every one behind) to where their PR says
  async fix(ids?: readonly string[]): Promise<LinearSyncRow[]> {
    const rows = await this.check()
    const out: LinearSyncRow[] = []
    for (const r of rows) {
      if ((!r.want && r.linked) || (ids && !ids.includes(r.id))) {
        out.push(r)
        continue
      }
      const t = this.store.get(r.id)
      let row = r
      try {
        if (!r.linked) {
          await this.linear.linkPr(t!.uuid, r.url, `#${r.number} ${r.title}`)
          this.store.journal(r.id, { kind: 'linear', title: `Linked PR #${r.number} to the Linear issue`, meta: { url: r.url } })
          row = { ...row, linked: true }
        }
        if (r.want) {
          await this.linear.moveToState(t!.uuid, r.want)
          this.store.patch(r.id, { linearState: r.want })
          this.store.journal(r.id, { kind: 'linear', title: `Moved to ${r.want} in Linear (sync with the PR)`, meta: { from: r.linear } })
          row = { ...row, linear: r.want, want: null }
        }
        out.push(row)
      } catch (error) {
        out.push({ ...row, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return out
  }
}
