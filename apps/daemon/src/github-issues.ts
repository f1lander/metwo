import type { FindScope, FoundIssue, LinearIssueView, LinearPerson } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { LinearComment, LinearIssue, ThreadComment } from './linear.js'
import { sh } from './runner/shell.js'
import type { Tracker } from './tracker.js'

export type Gh = (args: readonly string[]) => Promise<string>

interface GhUser {
  login: string
  id: number
  avatar_url?: string
  type?: string
}
interface GhIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  state: 'open' | 'closed'
  state_reason?: string | null
  labels: ({ name: string; color?: string } | string)[]
  user: GhUser | null
  assignees?: GhUser[]
  created_at: string
  updated_at: string
  pull_request?: unknown
}
interface GhComment {
  id?: number
  body: string
  created_at: string
  html_url: string
  user: GhUser | null
}

const AGENT = /\b(mevo|manix|metwo) agent\b/
const STATUS = /^status:\s*/i

const ghRun: (cwd: string) => Gh = (cwd) => async (args) => (await sh('gh', args, cwd, 30_000)).stdout

// GitHub Issues as the tracker, through the gh CLI you are already signed in with. Issues assigned
// to you in one repo (optionally only some labels) are the tickets; ids are "<prefix>-<number>".
// States are open and closed; with stateLabels the in-between ones are "status: <name>" labels.
export class GithubIssues implements Tracker {
  readonly kind = 'github' as const
  readonly label = 'GitHub'
  onLabelColors: ((colors: Record<string, string>) => void) | null = null
  private me: string | null = null
  private slug: string | null

  constructor(
    private readonly cfg: () => Config,
    private readonly gh: Gh = ghRun(cfg().repo.path),
  ) {
    this.slug = cfg().tracker.github.repo || null
  }

  private async repo(): Promise<string> {
    this.slug ??= (await this.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim()
    return this.slug
  }

  private async login(): Promise<string> {
    this.me ??= (await this.gh(['api', 'user', '--jq', '.login'])).trim()
    return this.me
  }

  private async api<T>(path: string, ...extra: string[]): Promise<T> {
    return JSON.parse(await this.gh(['api', path, ...extra])) as T
  }

  private get prefix(): string {
    return this.cfg().tracker.github.idPrefix || 'GH'
  }

  idFor(n: number): string {
    return `${this.prefix}-${n}`
  }

  // "#12", "12", "GH-12" or a link to an issue in this repo
  number(input: string): number | null {
    const s = input.trim()
    const url = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i.exec(s)
    if (url) return this.slug && url[1]!.toLowerCase() !== this.slug.toLowerCase() ? null : Number(url[2])
    const m = new RegExp(`^(?:#|${this.prefix}-)?(\\d+)$`, 'i').exec(s)
    return m ? Number(m[1]) : null
  }

  private names(labels: GhIssue['labels']): string[] {
    const list = labels.map((l) => (typeof l === 'string' ? { name: l } : l))
    const colors = Object.fromEntries(list.filter((l) => l.color).map((l) => [l.name, `#${l.color}`]))
    if (Object.keys(colors).length) this.onLabelColors?.(colors)
    return list.map((l) => l.name)
  }

  private state(i: Pick<GhIssue, 'state' | 'labels'>): string {
    if (i.state === 'closed') return this.cfg().linear.states.done
    const status = this.names(i.labels).find((l) => STATUS.test(l))
    return status ? status.replace(STATUS, '') : 'Open'
  }

  private person(u: GhUser | null | undefined): LinearPerson | undefined {
    return u ? { name: u.login, avatar: u.avatar_url ?? null, github: String(u.id) } : undefined
  }

  private toIssue(i: GhIssue): LinearIssue {
    const creator = this.person(i.user)
    return {
      id: this.idFor(i.number),
      uuid: String(i.number),
      title: i.title,
      description: i.body ?? '',
      url: i.html_url,
      branch: '',
      labels: this.names(i.labels).filter((l) => !STATUS.test(l)),
      priority: 0,
      estimate: null,
      state: this.state(i),
      createdBy: i.user?.login ?? 'unknown',
      ...(creator ? { creator } : {}),
    }
  }

  private found(i: GhIssue, me: string): FoundIssue {
    const assignee = i.assignees?.[0]?.login ?? null
    return {
      id: this.idFor(i.number),
      uuid: String(i.number),
      title: i.title,
      url: i.html_url,
      state: this.state(i),
      priority: 0,
      priorityLabel: 'No priority',
      estimate: null,
      labels: this.names(i.labels),
      description: (i.body ?? '').slice(0, 4000),
      updatedAt: i.updated_at,
      team: this.slug ?? '',
      project: null,
      cycle: null,
      assignee,
      mine: Boolean(i.assignees?.some((a) => a.login === me)),
      done: i.state === 'closed',
    }
  }

  async myOpenIssues(): Promise<readonly LinearIssue[]> {
    const [repo, me] = await Promise.all([this.repo(), this.login()])
    const labels = this.cfg().tracker.github.labels
    const q = `state=open&assignee=${encodeURIComponent(me)}&per_page=100${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`
    const list = await this.api<GhIssue[]>(`repos/${repo}/issues?${q}`)
    return list.filter((i) => !i.pull_request).map((i) => this.toIssue(i))
  }

  private async comments(n: string): Promise<GhComment[]> {
    const repo = await this.repo()
    return this.api<GhComment[]>(`repos/${repo}/issues/${n}/comments?per_page=100`)
  }

  // Find tickets: the repo's open unassigned issues, yours, or a text search (no cycles or projects)
  async find(scope: FindScope, opts: { query?: string }): Promise<readonly FoundIssue[]> {
    const [repo, me] = await Promise.all([this.repo(), this.login()])
    if (scope === 'project') return []
    if (scope === 'search') {
      const q = (opts.query ?? '').trim()
      if (q.length < 2) return []
      const r = await this.api<{ items: GhIssue[] }>(`search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open ${q}`)}&per_page=50`)
      return r.items.map((i) => this.found(i, me))
    }
    const who = scope === 'mine' ? `assignee=${encodeURIComponent(me)}` : 'assignee=none'
    const list = await this.api<GhIssue[]>(`repos/${repo}/issues?state=open&${who}&per_page=100&sort=updated`)
    return list.filter((i) => !i.pull_request).map((i) => this.found(i, me))
  }

  async humanComments(issueUuid: string): Promise<readonly LinearComment[]> {
    return (await this.comments(issueUuid))
      .filter((c) => c.user?.type !== 'Bot' && !AGENT.test(c.body))
      .map((c) => ({ author: c.user?.login ?? 'someone', body: c.body, createdAt: c.created_at }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // GitHub issue comments have no threads: each is its own
  async threadComments(issueUuid: string): Promise<readonly ThreadComment[]> {
    const me = await this.login()
    return (await this.comments(issueUuid))
      .map((c) => ({
        id: String(c.id ?? ''),
        parent: null,
        author: c.user?.login ?? 'someone',
        body: c.body,
        createdAt: c.created_at,
        url: c.html_url,
        mine: c.user?.login === me,
        bot: c.user?.type === 'Bot' || AGENT.test(c.body) || /mevo, \w+'s assistant/.test(c.body),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // a new comment that quotes the one it answers
  async reply(issueUuid: string, parentId: string, body: string): Promise<string | null> {
    const repo = await this.repo()
    const parent = await this.api<GhComment>(`repos/${repo}/issues/comments/${parentId}`).catch(() => null)
    const quote = parent ? `> **@${parent.user?.login ?? 'someone'}**: ${parent.body.replace(/\s+/g, ' ').trim().slice(0, 200)}\n\n` : ''
    return this.comment(issueUuid, `${quote}${body}`)
  }

  async createIssue(title: string, description: string): Promise<{ id: string; url: string }> {
    const repo = await this.repo()
    const i = await this.api<GhIssue>(`repos/${repo}/issues`, '-X', 'POST', '-f', `title=${title}`, '-f', `body=${description}`)
    return { id: this.idFor(i.number), url: i.html_url }
  }

  async issueView(issueUuid: string): Promise<LinearIssueView> {
    const repo = await this.repo()
    const [i, comments] = await Promise.all([this.api<GhIssue>(`repos/${repo}/issues/${issueUuid}`), this.comments(issueUuid)])
    const creator = this.person(i.user)
    const assignee = this.person(i.assignees?.[0])
    return {
      id: this.idFor(i.number),
      title: i.title,
      url: i.html_url,
      description: i.body ?? '',
      state: this.state(i),
      priority: 'No priority',
      assignee: assignee?.name ?? null,
      creator: creator?.name ?? 'unknown',
      ...(creator ? { creatorPerson: creator } : {}),
      ...(assignee ? { assigneePerson: assignee } : {}),
      labels: this.names(i.labels).filter((l) => !STATUS.test(l)),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      comments: comments
        .map((c) => {
          const person = this.person(c.user)
          return { author: c.user?.login ?? 'someone', body: c.body, createdAt: c.created_at, bot: c.user?.type === 'Bot' || AGENT.test(c.body), ...(person && c.user?.type !== 'Bot' ? { person } : {}) }
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }
  }

  async lookup(input: string): Promise<{ found: FoundIssue; issue: LinearIssue } | null> {
    const repo = await this.repo()
    const n = this.number(input)
    if (n === null) return null
    const i = await this.api<GhIssue>(`repos/${repo}/issues/${n}`).catch(() => null)
    if (!i || i.pull_request) return null
    return { found: this.found(i, await this.login()), issue: this.toIssue(i) }
  }

  async comment(issueUuid: string, body: string): Promise<string | null> {
    const repo = await this.repo()
    const c = await this.api<GhComment>(`repos/${repo}/issues/${issueUuid}/comments`, '-X', 'POST', '-f', `body=${body}`)
    return c.html_url ?? null
  }

  // the state and the PRs that reference the issue (GitHub links them by itself through "Fixes #n")
  async states(uuids: readonly string[]): Promise<Map<string, { name: string; type: string; links: readonly string[] }>> {
    const repo = await this.repo()
    const out = new Map<string, { name: string; type: string; links: readonly string[] }>()
    for (const n of uuids) {
      const i = await this.api<GhIssue>(`repos/${repo}/issues/${n}`).catch(() => null)
      if (!i) continue
      type Ev = { event: string; source?: { issue?: { html_url: string; pull_request?: unknown } } }
      const events = await this.api<Ev[]>(`repos/${repo}/issues/${n}/timeline?per_page=100`).catch(() => [] as Ev[])
      const links = events.filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request).map((e) => e.source!.issue!.html_url)
      out.set(n, { name: this.state(i), type: i.state === 'closed' ? 'completed' : this.state(i) === 'Open' ? 'unstarted' : 'started', links })
    }
    return out
  }

  // the PR body's "Fixes #n" already links it; a comment covers PRs opened some other way
  async linkPr(issueUuid: string, url: string, title: string): Promise<void> {
    await this.comment(issueUuid, `PR: ${title} ${url}`)
  }

  async moveToState(issueUuid: string, stateName: string): Promise<void> {
    const repo = await this.repo()
    const states = this.cfg().linear.states
    if (stateName === states.done) {
      await this.gh(['api', `repos/${repo}/issues/${issueUuid}`, '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed'])
      return
    }
    if (!this.cfg().tracker.github.stateLabels) return
    const i = await this.api<GhIssue>(`repos/${repo}/issues/${issueUuid}`)
    const keep = this.names(i.labels).filter((l) => !STATUS.test(l))
    await this.gh(['api', `repos/${repo}/issues/${issueUuid}/labels`, '-X', 'PUT', ...[...keep, `status: ${stateName}`].flatMap((l) => ['-f', `labels[]=${l}`])])
    if (i.state === 'closed') await this.gh(['api', `repos/${repo}/issues/${issueUuid}`, '-X', 'PATCH', '-f', 'state=open'])
  }

  // attachments on github.com need your token; anything else is fetched plainly
  async download(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const headers: Record<string, string> = {}
    if (/^https:\/\/(github\.com|[\w.-]*githubusercontent\.com)\//.test(url)) {
      const token = (await this.gh(['auth', 'token']).catch(() => '')).trim()
      if (token) headers.Authorization = `token ${token}`
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
  }

  async assignToMe(ids: readonly string[]): Promise<{ assigned: string[]; failed: { id: string; error: string }[] }> {
    const [repo, me] = await Promise.all([this.repo(), this.login()])
    const assigned: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      const n = this.number(id)
      if (n === null) {
        failed.push({ id, error: 'not an issue number' })
        continue
      }
      try {
        await this.gh(['api', `repos/${repo}/issues/${n}/assignees`, '-X', 'POST', '-f', `assignees[]=${me}`])
        assigned.push(this.idFor(n))
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { assigned, failed }
  }
}
