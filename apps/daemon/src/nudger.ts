import { type Nudge, NUDGE_COOLDOWN_HOURS, nudges, nudgeText, type Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import { githubPerson } from './runner/github.js'
import type { Slack } from './slack.js'
import type { Store } from './store.js'

export interface NudgeDraft {
  readonly login: string
  // their Slack member id, when mevo found it (else you give it once)
  readonly slackId: string | null
  readonly name: string
  readonly local: string | null
  readonly offHours: boolean
  readonly text: string
  readonly items: readonly Nudge[]
}

// Drafts and sends the nudges: one DM per reviewer, from you, listing every PR that waits on them.
export class Nudger {
  private readonly people = new Map<string, Promise<{ name: string | null; emails: string[] }>>()

  constructor(
    private readonly cfg: () => Config,
    private readonly store: Store,
    private readonly slack: Slack,
  ) {}

  // every nudge you could send now; `due` ones have waited long enough
  all(now = Date.now()): Nudge[] {
    return this.store.all().flatMap((t) => nudges(t, now))
  }

  private github(login: string): Promise<{ name: string | null; emails: string[] }> {
    const key = login.toLowerCase()
    let p = this.people.get(key)
    if (!p) {
      p = githubPerson(this.cfg().repo.path, login).catch(() => ({ name: null, emails: [] }))
      this.people.set(key, p)
    }
    return p
  }

  async draft(picks: readonly { id: string; login: string }[]): Promise<NudgeDraft[]> {
    const want = new Set(picks.map((p) => `${p.id}|${p.login.toLowerCase()}`))
    const found = this.all().filter((n) => want.has(`${n.id}|${n.login.toLowerCase()}`))
    const byLogin = new Map<string, Nudge[]>()
    for (const n of found) byLogin.set(n.login.toLowerCase(), [...(byLogin.get(n.login.toLowerCase()) ?? []), n])
    const out: NudgeDraft[] = []
    for (const items of byLogin.values()) {
      const login = (items[0] as Nudge).login
      const gh = await this.github(login)
      const slackId = await this.slack.findPerson(login, gh.emails, gh.name).catch(() => null)
      const info = slackId ? await this.slack.personInfo(slackId) : null
      out.push({
        login,
        slackId,
        name: info?.name ?? gh.name ?? login,
        local: info?.local ?? null,
        offHours: info?.offHours ?? false,
        text: nudgeText(info?.first || gh.name || login, items),
        items,
      })
    }
    return out
  }

  // Settings → auto nudge: the due ones go out by themselves, one DM per reviewer, only in their
  // working hours and at most once a day each. Returns who was nudged.
  async auto(now = Date.now()): Promise<{ login: string; numbers: number[] }[]> {
    if (!this.cfg().slack.autoNudge) return []
    const all = this.all(now)
    const due = all.filter((n) => n.due)
    const logins = [...new Set(due.map((n) => n.login.toLowerCase()))]
    const sent: { login: string; numbers: number[] }[] = []
    for (const key of logins.slice(0, 5)) {
      // the cooldown is per reviewer, across every PR
      const last = Math.max(0, ...all.filter((n) => n.login.toLowerCase() === key && n.last).map((n) => Date.parse(n.last as string)))
      if (now - last < NUDGE_COOLDOWN_HOURS * 3_600_000) continue
      const [d] = await this.draft(due.filter((n) => n.login.toLowerCase() === key).map((n) => ({ id: n.id, login: n.login })))
      if (!d?.slackId || d.offHours || !d.local) continue
      try {
        await this.send(d.login, d.slackId, d.text, d.items.map((n) => n.id), now)
        sent.push({ login: d.login, numbers: d.items.map((n) => n.number) })
      } catch {
        // tried again on the next round
      }
    }
    return sent
  }

  async send(login: string, slackId: string, text: string, ids: readonly string[], auto?: number): Promise<void> {
    if (!/^[UW][A-Z0-9]{5,}$/.test(slackId)) throw new Error('a Slack member id looks like U01ABCDEF')
    if (!text.trim()) throw new Error('the message is empty')
    this.slack.setPerson(login, slackId)
    await this.slack.dm(slackId, text.trim())
    const at = new Date(auto ?? Date.now()).toISOString()
    for (const id of ids) {
      const t: Ticket | undefined = this.store.get(id)
      if (!t) continue
      this.store.patch(id, { nudges: { ...(t.nudges ?? {}), [login.toLowerCase()]: { at, to: slackId } } })
      this.store.journal(id, { kind: 'note', title: `Nudged ${login} on Slack${auto !== undefined ? ' (auto)' : ''}`, body: text.trim() })
    }
  }
}
