import { LinearClient } from '@linear/sdk'
import type { CycleView, FindScope, FoundIssue, LinearIssueView, LinearProject, LinearPerson } from '@ticketflow/shared'
import type { Config } from './config.js'
import { log } from './log.js'
import type { Tracker } from './tracker.js'

export interface LinearIssue {
  readonly id: string
  readonly uuid: string
  readonly title: string
  readonly description: string
  readonly url: string
  readonly branch: string
  readonly labels: readonly string[]
  readonly priority: number
  readonly estimate: number | null
  readonly state: string
  readonly createdBy: string
  readonly creator?: LinearPerson
}

export interface LinearComment {
  readonly author: string
  readonly body: string
  readonly createdAt: string
}

interface IssueNode {
  identifier: string
  id: string
  title: string
  description: string | null
  url: string
  branchName: string
  priority: number
  estimate: number | null
  state: { name: string } | null
  labels: { nodes: { name: string; color?: string }[] }
  creator: LinearUserNode | null
}

// One request for the whole list. The SDK's lazy getters cost 3 extra calls per issue,
// which is what made polling every few seconds too expensive.
const DONE_SINCE = `query DoneSince($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 250, after: $after) {
    nodes { assignee { id name displayName avatarUrl isMe gitHubUserId } }
    pageInfo { hasNextPage endCursor }
  }
}`

const MY_ISSUES = /* GraphQL */ `
  query MyIssues($filter: IssueFilter!) {
    issues(first: 100, filter: $filter) {
      nodes {
        identifier id title description url branchName priority estimate
        state { name }
        labels(first: 10) { nodes { name color } }
        creator { displayName name avatarUrl gitHubUserId }
      }
    }
  }
`

const FOUND_FIELDS = `identifier id title description url branchName priority priorityLabel estimate updatedAt
  state { name type } labels(first: 10) { nodes { name color } } creator { displayName name avatarUrl gitHubUserId }
  assignee { displayName name isMe } team { key } project { name } cycle { number name }`

const FIND = /* GraphQL */ `
  query Find($filter: IssueFilter!) {
    issues(first: 100, filter: $filter, orderBy: updatedAt) { nodes { ${FOUND_FIELDS} } }
  }
`

const ONE_ISSUE = /* GraphQL */ `
  query One($id: String!) { issue(id: $id) { ${FOUND_FIELDS} } }
`

const PROJECTS = /* GraphQL */ `
  query Projects($filter: ProjectFilter) {
    projects(first: 100, orderBy: updatedAt, filter: $filter) { nodes { id name completedAt canceledAt teams(first: 5) { nodes { key } } } }
  }
`

// a project link: linear.app/<workspace>/project/<name-slug>-<slugId>
export function projectSlug(input: string): string | null {
  return /linear\.app\/[^/\s]+\/project\/(?:[^/\s?#]*-)?([0-9a-f]{8,})(?:[/?#]|$)/i.exec(input.trim())?.[1] ?? null
}

interface FoundNode extends IssueNode {
  priorityLabel: string
  updatedAt: string
  state: { name: string; type?: string } | null
  assignee: { displayName: string | null; name: string | null; isMe: boolean } | null
  team: { key: string } | null
  project: { name: string } | null
  cycle: { number: number; name: string | null } | null
}

// "WEB-123", "123" (the configured team), or a Linear link to the issue
export function issueRef(input: string, teamKey: string): string | null {
  const s = input.trim()
  const fromUrl = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i.exec(s)?.[1]
  if (fromUrl) return fromUrl.toUpperCase()
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s)) return s.toUpperCase()
  if (/^#?\d+$/.test(s) && teamKey) return `${teamKey}-${s.replace('#', '')}`.toUpperCase()
  return null
}

const COMMENTS = /* GraphQL */ `
  query IssueComments($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes { id body createdAt url parent { id } user { displayName name isMe } botActor { name } }
      }
    }
  }
`

const ISSUE_VIEW = /* GraphQL */ `
  query IssueView($id: String!) {
    issue(id: $id) {
      identifier title url description priorityLabel createdAt updatedAt
      state { name }
      assignee { displayName name avatarUrl gitHubUserId }
      creator { displayName name avatarUrl gitHubUserId }
      labels { nodes { name color } }
      comments(first: 100) { nodes { body createdAt user { displayName name avatarUrl gitHubUserId } botActor { name } } }
    }
  }
`

interface IssueViewNode {
  identifier: string
  title: string
  url: string
  description: string | null
  priorityLabel: string
  createdAt: string
  updatedAt: string
  state: { name: string } | null
  assignee: LinearUserNode | null
  creator: LinearUserNode | null
  labels: { nodes: { name: string; color?: string }[] }
  comments: { nodes: CommentNode[] }
}

const MENTIONS = /* GraphQL */ `
  query Mentions {
    notifications(first: 40) {
      nodes {
        type
        createdAt
        ... on IssueNotification {
          actor { displayName name }
          issue { identifier description }
          comment { body }
        }
      }
    }
  }
`

const CYCLE = /* GraphQL */ `
  query OpenInCycle($team: String!) {
    teams(first: 1, filter: { key: { eq: $team } }) {
      nodes {
        activeCycle {
          name number endsAt
          issues(first: 100, filter: { assignee: { null: true }, state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes { identifier id title description updatedAt url priority priorityLabel estimate state { name } labels(first: 5) { nodes { name color } } }
          }
        }
      }
    }
  }
`

interface CycleNode {
  activeCycle: {
    name: string | null
    number: number
    endsAt: string
    issues: { nodes: { identifier: string; id: string; title: string; description?: string | null; updatedAt?: string; url: string; priority: number; priorityLabel: string; estimate: number | null; state: { name: string } | null; labels: { nodes: { name: string; color?: string }[] } }[] }
  } | null
}

interface LinearUserNode {
  displayName: string | null
  name: string | null
  avatarUrl?: string | null
  gitHubUserId?: string | null
}

const person = (u: LinearUserNode | null | undefined): LinearPerson | undefined =>
  u ? { name: u.displayName ?? u.name ?? 'someone', avatar: u.avatarUrl ?? null, github: u.gitHubUserId ?? null } : undefined

interface CommentNode {
  id?: string
  body: string
  createdAt: string
  url?: string
  parent?: { id: string } | null
  user: (LinearUserNode & { isMe?: boolean }) | null
  botActor: { name: string | null } | null
}

// a comment with what it takes to answer it in its thread
export interface ThreadComment {
  readonly id: string
  readonly parent: string | null
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
  readonly mine: boolean
  readonly bot: boolean
}

export class Linear implements Tracker {
  readonly kind = 'linear' as const
  readonly label = 'Linear'
  private readonly client: LinearClient
  private stateIds: Map<string, string> | null = null
  // label colors seen in any response, handed to the store for the app
  onLabelColors: ((colors: Record<string, string>) => void) | null = null

  private names(nodes: readonly { name: string; color?: string }[]): string[] {
    const colors = Object.fromEntries(nodes.filter((n) => n.color).map((n) => [n.name, n.color as string]))
    if (Object.keys(colors).length) this.onLabelColors?.(colors)
    return nodes.map((n) => n.name)
  }

  constructor(
    private readonly apiKey: string,
    private readonly cfg: Config['linear'],
  ) {
    this.client = new LinearClient({ apiKey })
  }

  private fastQueryBroken = false

  // One GraphQL request; if Linear ever rejects it, the slower SDK path keeps polling alive.
  async myOpenIssues(): Promise<readonly LinearIssue[]> {
    if (!this.fastQueryBroken) {
      try {
        return await this.fastIssues()
      } catch (error) {
        this.fastQueryBroken = true
        log.warn('linear fast query failed, falling back to the SDK path', error)
      }
    }
    return this.sdkIssues()
  }

  private async fastIssues(): Promise<readonly LinearIssue[]> {
    const teams = this.cfg.teams?.length ? this.cfg.teams : [this.cfg.teamKey]
    const filter = {
      assignee: { isMe: { eq: true } },
      ...(teams.includes('*') ? {} : { team: { key: { in: [...teams] } } }),
      state: { or: [{ name: { in: [...this.cfg.watchStates] } }, { type: { in: [...this.cfg.watchStateTypes] } }] },
    }
    const data = await this.client.client.request<{ issues: { nodes: IssueNode[] } }, Record<string, unknown>>(MY_ISSUES, { filter })
    return data.issues.nodes.map((issue) => ({
      id: issue.identifier,
      uuid: issue.id,
      title: issue.title,
      description: issue.description ?? '',
      url: issue.url,
      branch: issue.branchName,
      labels: this.names(issue.labels.nodes),
      priority: issue.priority,
      estimate: issue.estimate ?? null,
      state: issue.state?.name ?? 'unknown',
      createdBy: issue.creator?.displayName ?? issue.creator?.name ?? 'unknown',
      ...(issue.creator ? { creator: person(issue.creator) as LinearPerson } : {}),
    }))
  }

  private async sdkIssues(): Promise<readonly LinearIssue[]> {
    const result = await this.client.issues({
      filter: {
        assignee: { isMe: { eq: true } },
        ...((this.cfg.teams ?? []).includes('*') ? {} : { team: { key: { in: [...(this.cfg.teams?.length ? this.cfg.teams : [this.cfg.teamKey])] } } }),
        state: { or: [{ name: { in: [...this.cfg.watchStates] } }, { type: { in: [...this.cfg.watchStateTypes] } }] },
      },
      first: 100,
    })
    return Promise.all(
      result.nodes.map(async (issue) => {
        const [labels, state, creator] = await Promise.all([issue.labels(), issue.state, issue.creator])
        return {
          id: issue.identifier,
          uuid: issue.id,
          title: issue.title,
          description: issue.description ?? '',
          url: issue.url,
          branch: issue.branchName,
          labels: this.names(labels.nodes),
          priority: issue.priority,
          estimate: issue.estimate ?? null,
          state: state?.name ?? 'unknown',
          createdBy: creator?.displayName ?? creator?.name ?? 'unknown',
          ...(creator ? { creator: { name: creator.displayName || creator.name, avatar: creator.avatarUrl ?? null, github: creator.gitHubUserId ?? null } } : {}),
        }
      }),
    )
  }

  // Human comments only, oldest first. Our own signed agent comments are left out.
  async humanComments(issueUuid: string): Promise<readonly LinearComment[]> {
    const data = await this.client.client.request<{ issue: { comments: { nodes: CommentNode[] } } }, Record<string, unknown>>(COMMENTS, { id: issueUuid })
    return data.issue.comments.nodes
      .filter((c) => !c.botActor && !/\b(mevo|manix|metwo) agent\b/.test(c.body))
      .map((c) => ({ author: c.user?.displayName ?? c.user?.name ?? 'someone', body: c.body, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // every comment with its id and thread, oldest first (the newest 50)
  async threadComments(issueUuid: string): Promise<readonly ThreadComment[]> {
    const data = await this.client.client.request<{ issue: { comments: { nodes: CommentNode[] } } }, Record<string, unknown>>(COMMENTS, { id: issueUuid })
    return data.issue.comments.nodes
      .map((c) => ({
        id: c.id ?? '',
        parent: c.parent?.id ?? null,
        author: c.botActor?.name ?? c.user?.displayName ?? c.user?.name ?? 'someone',
        body: c.body,
        createdAt: c.createdAt,
        url: c.url ?? '',
        mine: Boolean(c.user?.isMe),
        bot: Boolean(c.botActor) || /\b(mevo|manix|metwo) agent\b|mevo, \w+'s assistant/.test(c.body),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // an answer under a comment, in its thread
  async reply(issueUuid: string, parentId: string, body: string): Promise<string | null> {
    const result = await this.client.createComment({ issueId: issueUuid, body, parentId })
    const comment = await result.comment
    return comment?.url ?? null
  }

  // a new issue in your team, from a request that is out of the ticket's scope
  async createIssue(title: string, description: string): Promise<{ id: string; url: string }> {
    const teams = await this.client.teams({ filter: { key: { eq: this.cfg.teamKey } } })
    const team = teams.nodes[0]
    if (!team) throw new Error(`Linear team ${this.cfg.teamKey} not found`)
    const result = await this.client.createIssue({ teamId: team.id, title, description })
    const issue = await result.issue
    if (!issue) throw new Error('Linear did not create the issue')
    return { id: issue.identifier, url: issue.url }
  }

  async issueView(issueUuid: string): Promise<LinearIssueView> {
    const { issue: i } = await this.client.client.request<{ issue: IssueViewNode }, Record<string, unknown>>(ISSUE_VIEW, { id: issueUuid })
    const who = (u: { displayName: string | null; name: string | null } | null) => u?.displayName ?? u?.name ?? null
    return {
      id: i.identifier,
      title: i.title,
      url: i.url,
      description: i.description ?? '',
      state: i.state?.name ?? 'unknown',
      priority: i.priorityLabel,
      assignee: who(i.assignee),
      creator: who(i.creator) ?? 'unknown',
      ...(i.creator ? { creatorPerson: person(i.creator) as LinearPerson } : {}),
      ...(i.assignee ? { assigneePerson: person(i.assignee) as LinearPerson } : {}),
      labels: this.names(i.labels.nodes),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      comments: i.comments.nodes
        .map((c) => ({ author: c.botActor?.name ?? who(c.user) ?? 'someone', body: c.body, createdAt: c.createdAt, bot: Boolean(c.botActor) || /\b(mevo|manix|metwo) agent\b/.test(c.body), ...(c.user && !c.botActor ? { person: person(c.user) as LinearPerson } : {}) }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }
  }

  // Unassigned, still-open issues in the team's current cycle, most urgent first.
  async cycleView(): Promise<CycleView> {
    const data = await this.client.client.request<{ teams: { nodes: CycleNode[] } }, Record<string, unknown>>(CYCLE, { team: this.cfg.teamKey })
    const cycle = data.teams.nodes[0]?.activeCycle
    if (!cycle) return { cycle: null, issues: [] }
    const rank = (p: number) => (p === 0 ? 5 : p)
    return {
      cycle: { name: cycle.name ?? `Cycle ${cycle.number}`, number: cycle.number, endsAt: cycle.endsAt },
      issues: cycle.issues.nodes
        .map((i) => ({
          id: i.identifier,
          uuid: i.id,
          title: i.title,
          url: i.url,
          state: i.state?.name ?? 'unknown',
          priority: i.priority,
          priorityLabel: i.priorityLabel,
          estimate: i.estimate ?? null,
          labels: this.names(i.labels.nodes),
          description: (i.description ?? '').slice(0, 4000),
          ...(i.updatedAt ? { updatedAt: i.updatedAt } : {}),
        }))
        .sort((a, b) => rank(a.priority) - rank(b.priority) || a.id.localeCompare(b.id, undefined, { numeric: true })),
    }
  }

  private found(i: FoundNode): FoundIssue {
    const who = i.assignee ? (i.assignee.displayName ?? i.assignee.name) : null
    return {
      id: i.identifier,
      uuid: i.id,
      title: i.title,
      url: i.url,
      state: i.state?.name ?? 'unknown',
      priority: i.priority,
      priorityLabel: i.priorityLabel,
      estimate: i.estimate ?? null,
      labels: this.names(i.labels.nodes),
      description: (i.description ?? '').slice(0, 4000),
      updatedAt: i.updatedAt,
      team: i.team?.key ?? i.identifier.split('-')[0] ?? '',
      project: i.project?.name ?? null,
      cycle: i.cycle ? (i.cycle.name ?? `Cycle ${i.cycle.number}`) : null,
      assignee: who,
      mine: Boolean(i.assignee?.isMe),
      done: i.state?.type === 'completed' || i.state?.type === 'canceled',
    }
  }

  // Beyond the current cycle: the team's unassigned backlog, a project, a text search, or
  // everything assigned to you in any team.
  async find(scope: FindScope, opts: { query?: string; project?: string; team?: string }): Promise<readonly FoundIssue[]> {
    const open = { state: { type: { nin: ['completed', 'canceled'] } } }
    const team = opts.team || this.cfg.teamKey
    const filter =
      scope === 'backlog'
        ? { team: { key: { eq: team } }, assignee: { null: true }, ...open }
        : scope === 'project'
          ? { project: { id: { eq: opts.project ?? '' } }, ...open }
          : scope === 'mine'
            ? { assignee: { isMe: { eq: true } }, ...open }
            : { or: [{ title: { containsIgnoreCase: opts.query ?? '' } }, { description: { containsIgnoreCase: opts.query ?? '' } }] }
    if (scope === 'search' && (opts.query ?? '').trim().length < 2) return []
    if (scope === 'project' && !opts.project) return []
    const data = await this.client.client.request<{ issues: { nodes: FoundNode[] } }, Record<string, unknown>>(FIND, { filter })
    const rank = (p: number) => (p === 0 ? 5 : p)
    const list = data.issues.nodes.map((n) => this.found(n))
    return scope === 'search' ? list : [...list].sort((a, b) => rank(a.priority) - rank(b.priority) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  // the 100 most recently updated open projects, or any project whose name matches `query`
  async projects(query?: string): Promise<readonly LinearProject[]> {
    const q = query?.trim()
    const data = await this.client.client.request<{ projects: { nodes: { id: string; name: string; completedAt: string | null; canceledAt: string | null; teams: { nodes: { key: string }[] } }[] } }, Record<string, unknown>>(PROJECTS, {
      filter: q ? { name: { containsIgnoreCase: q } } : null,
    })
    return data.projects.nodes.filter((p) => q || (!p.completedAt && !p.canceledAt)).map((p) => ({ id: p.id, name: p.name, teams: p.teams.nodes.map((t) => t.key) }))
  }

  // a pasted project link, whatever its age or state
  async projectByLink(input: string): Promise<LinearProject | null> {
    const slugId = projectSlug(input)
    if (!slugId) return null
    const data = await this.client.client.request<{ projects: { nodes: { id: string; name: string; teams: { nodes: { key: string }[] } }[] } }, Record<string, unknown>>(PROJECTS, { filter: { slugId: { eq: slugId } } })
    const p = data.projects.nodes[0]
    return p ? { id: p.id, name: p.name, teams: p.teams.nodes.map((t) => t.key) } : null
  }

  // One issue by "WEB-123", "123" or its Linear link, with what the board needs to track it.
  async lookup(input: string): Promise<{ found: FoundIssue; issue: LinearIssue } | null> {
    const id = issueRef(input, this.cfg.teamKey)
    if (!id) return null
    const data = await this.client.client.request<{ issue: FoundNode | null }, Record<string, unknown>>(ONE_ISSUE, { id }).catch(() => ({ issue: null }))
    const i = data.issue
    if (!i) return null
    return {
      found: this.found(i),
      issue: {
        id: i.identifier,
        uuid: i.id,
        title: i.title,
        description: i.description ?? '',
        url: i.url,
        branch: i.branchName,
        labels: this.names(i.labels.nodes),
        priority: i.priority,
        estimate: i.estimate ?? null,
        state: i.state?.name ?? 'unknown',
        createdBy: i.creator?.displayName ?? i.creator?.name ?? 'unknown',
        ...(i.creator ? { creator: person(i.creator) as LinearPerson } : {}),
      },
    }
  }

  // Issues completed since a date in your teams, counted per assignee (unassigned ones left out).
  // Issues in a started state now (in progress, in review, QA) in your teams, per assignee.
  async startedNow(): Promise<{ id: string; name: string; avatar: string | null; github: string | null; you: boolean; count: number }[]> {
    return this.countByAssignee({ state: { type: { eq: 'started' } } })
  }

  async doneSince(since: string): Promise<{ id: string; name: string; avatar: string | null; github: string | null; you: boolean; count: number }[]> {
    return this.countByAssignee({ completedAt: { gte: since } })
  }

  private async countByAssignee(where: Record<string, unknown>): Promise<{ id: string; name: string; avatar: string | null; github: string | null; you: boolean; count: number }[]> {
    const teams = this.cfg.teams?.length ? this.cfg.teams : [this.cfg.teamKey]
    const filter = { ...where, ...(teams.includes('*') ? {} : { team: { key: { in: [...teams] } } }) }
    const by = new Map<string, { id: string; name: string; avatar: string | null; github: string | null; you: boolean; count: number }>()
    let after: string | null = null
    for (let page = 0; page < 8; page++) {
      type Page = { issues: { nodes: { assignee: { id: string; name: string; displayName: string; avatarUrl: string | null; isMe: boolean; gitHubUserId: string | null } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
      const data: Page = await this.client.client.request<Page, Record<string, unknown>>(DONE_SINCE, { filter, after })
      for (const n of data.issues.nodes) {
        const a = n.assignee
        if (!a) continue
        const row = by.get(a.id) ?? { id: a.id, name: a.displayName || a.name, avatar: a.avatarUrl, github: a.gitHubUserId, you: a.isMe, count: 0 }
        by.set(a.id, { ...row, count: row.count + 1 })
      }
      if (!data.issues.pageInfo.hasNextPage) break
      after = data.issues.pageInfo.endCursor
    }
    return [...by.values()].sort((a, b) => b.count - a.count)
  }

  // Assigns to the API key's owner. Accepts identifiers (WEB-123) or uuids.
  async assignToMe(ids: readonly string[]): Promise<{ assigned: string[]; failed: { id: string; error: string }[] }> {
    const me = await this.client.viewer
    const assigned: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      try {
        const issue = await this.client.issue(id)
        await this.client.updateIssue(issue.id, { assigneeId: me.id })
        assigned.push(issue.identifier)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { assigned, failed }
  }

  // Linear uploads need the API key; anything else is fetched plainly.
  async download(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const headers: Record<string, string> = url.includes('uploads.linear.app') ? { Authorization: this.apiKey } : {}
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
  }

  // GitHub PR links in comments and descriptions that mention you: "@edax can you review …/pull/1625".
  async mentionedPrs(): Promise<readonly { url: string; issue: string; by: string; at: string }[]> {
    type Node = { type: string; createdAt: string; actor?: { displayName: string | null; name: string | null } | null; issue?: { identifier: string; description: string | null } | null; comment?: { body: string } | null }
    const data = await this.client.client.request<{ notifications: { nodes: Node[] } }, Record<string, unknown>>(MENTIONS, {})
    const out: { url: string; issue: string; by: string; at: string }[] = []
    for (const n of data.notifications.nodes) {
      if (!/mention/i.test(n.type)) continue
      const text = n.comment?.body ?? n.issue?.description ?? ''
      for (const m of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) {
        out.push({ url: m[0], issue: n.issue?.identifier ?? '', by: n.actor?.displayName ?? n.actor?.name ?? 'someone', at: n.createdAt })
      }
    }
    return out
  }

  async comment(issueUuid: string, body: string): Promise<string | null> {
    const result = await this.client.createComment({ issueId: issueUuid, body })
    const comment = await result.comment
    return comment?.url ?? null
  }

  // the current state of these issues and the links attached to them, by uuid (100 per request)
  async states(uuids: readonly string[]): Promise<Map<string, { name: string; type: string; links: readonly string[] }>> {
    const out = new Map<string, { name: string; type: string; links: readonly string[] }>()
    for (let i = 0; i < uuids.length; i += 100) {
      const data = await this.client.client.request<{ issues: { nodes: { id: string; state: { name: string; type: string } | null; attachments: { nodes: { url: string }[] } }[] } }, Record<string, unknown>>(
        'query States($ids: [ID!]) { issues(first: 100, filter: { id: { in: $ids } }) { nodes { id state { name type } attachments(first: 25) { nodes { url } } } } }',
        { ids: uuids.slice(i, i + 100) },
      )
      for (const n of data.issues.nodes) if (n.state) out.set(n.id, { ...n.state, links: n.attachments.nodes.map((a) => a.url) })
    }
    return out
  }

  // The PR on the issue, the way Linear's GitHub integration shows it; a plain link if that fails
  async linkPr(issueUuid: string, url: string, title: string): Promise<void> {
    try {
      await this.client.client.request('mutation LinkPr($issueId: String!, $url: String!) { attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success } }', { issueId: issueUuid, url })
    } catch {
      await this.client.client.request('mutation LinkUrl($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }', { issueId: issueUuid, url, title })
    }
  }

  // by the issue's own team, so issues taken from other teams move too
  async moveToState(issueUuid: string, stateName: string): Promise<void> {
    const issue = await this.client.issue(issueUuid)
    const team = await issue.team
    const ids = team && team.key !== this.cfg.teamKey ? new Map((await team.states()).nodes.map((s) => [s.name, s.id])) : await this.loadStateIds()
    const stateId = ids.get(stateName)
    if (!stateId) throw new Error(`Linear state "${stateName}" not found for team ${team?.key ?? this.cfg.teamKey}`)
    await this.client.updateIssue(issueUuid, { stateId })
  }

  private async loadStateIds(): Promise<Map<string, string>> {
    if (this.stateIds) return this.stateIds
    const teams = await this.client.teams({ filter: { key: { eq: this.cfg.teamKey } } })
    const team = teams.nodes[0]
    if (!team) throw new Error(`Linear team ${this.cfg.teamKey} not found`)
    const states = await team.states()
    this.stateIds = new Map(states.nodes.map((s) => [s.name, s.id]))
    return this.stateIds
  }
}
