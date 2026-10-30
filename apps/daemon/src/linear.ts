import { LinearClient } from '@linear/sdk'
import type { CycleView, LinearIssueView } from '@ticketflow/shared'
import type { Config } from './config.js'
import { log } from './log.js'

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
  creator: { displayName: string | null; name: string | null } | null
}

// One request for the whole list. The SDK's lazy getters cost 3 extra calls per issue,
// which is what made polling every few seconds too expensive.
const MY_ISSUES = /* GraphQL */ `
  query MyIssues($team: String!, $states: [String!]!, $types: [String!]!) {
    issues(
      first: 50
      filter: {
        assignee: { isMe: { eq: true } }
        team: { key: { eq: $team } }
        state: { or: [{ name: { in: $states } }, { type: { in: $types } }] }
      }
    ) {
      nodes {
        identifier id title description url branchName priority estimate
        state { name }
        labels(first: 10) { nodes { name color } }
        creator { displayName name }
      }
    }
  }
`

const COMMENTS = /* GraphQL */ `
  query IssueComments($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes { body createdAt user { displayName name } botActor { name } }
      }
    }
  }
`

const ISSUE_VIEW = /* GraphQL */ `
  query IssueView($id: String!) {
    issue(id: $id) {
      identifier title url description priorityLabel createdAt updatedAt
      state { name }
      assignee { displayName name }
      creator { displayName name }
      labels { nodes { name color } }
      comments(first: 100) { nodes { body createdAt user { displayName name } botActor { name } } }
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
  assignee: { displayName: string | null; name: string | null } | null
  creator: { displayName: string | null; name: string | null } | null
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
            nodes { identifier id title url priority priorityLabel estimate state { name } labels(first: 5) { nodes { name color } } }
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
    issues: { nodes: { identifier: string; id: string; title: string; url: string; priority: number; priorityLabel: string; estimate: number | null; state: { name: string } | null; labels: { nodes: { name: string; color?: string }[] } }[] }
  } | null
}

interface CommentNode {
  body: string
  createdAt: string
  user: { displayName: string | null; name: string | null } | null
  botActor: { name: string | null } | null
}

export class Linear {
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
    const data = await this.client.client.request<{ issues: { nodes: IssueNode[] } }, Record<string, unknown>>(MY_ISSUES, {
      team: this.cfg.teamKey,
      states: [...this.cfg.watchStates],
      types: [...this.cfg.watchStateTypes],
    })
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
    }))
  }

  private async sdkIssues(): Promise<readonly LinearIssue[]> {
    const result = await this.client.issues({
      filter: {
        assignee: { isMe: { eq: true } },
        team: { key: { eq: this.cfg.teamKey } },
        state: { or: [{ name: { in: [...this.cfg.watchStates] } }, { type: { in: [...this.cfg.watchStateTypes] } }] },
      },
      first: 50,
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
        }
      }),
    )
  }

  // Human comments only, oldest first. Our own signed agent comments are left out.
  async humanComments(issueUuid: string): Promise<readonly LinearComment[]> {
    const data = await this.client.client.request<{ issue: { comments: { nodes: CommentNode[] } } }, Record<string, unknown>>(COMMENTS, { id: issueUuid })
    return data.issue.comments.nodes
      .filter((c) => !c.botActor && !c.body.includes('metwo agent'))
      .map((c) => ({ author: c.user?.displayName ?? c.user?.name ?? 'someone', body: c.body, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      labels: this.names(i.labels.nodes),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      comments: i.comments.nodes
        .map((c) => ({ author: c.botActor?.name ?? who(c.user) ?? 'someone', body: c.body, createdAt: c.createdAt, bot: Boolean(c.botActor) || c.body.includes('metwo agent') }))
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
        }))
        .sort((a, b) => rank(a.priority) - rank(b.priority) || a.id.localeCompare(b.id, undefined, { numeric: true })),
    }
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

  async moveToState(issueUuid: string, stateName: string): Promise<void> {
    const ids = await this.loadStateIds()
    const stateId = ids.get(stateName)
    if (!stateId) throw new Error(`Linear state "${stateName}" not found for team ${this.cfg.teamKey}`)
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
