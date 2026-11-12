import type { CycleView, FindScope, FoundIssue, LinearIssueView, LinearProject } from '@ticketflow/shared'
import type { LinearComment, LinearIssue, ThreadComment } from './linear.js'

export type TrackerKind = 'linear' | 'github'

type Count = { id: string; name: string; avatar: string | null; github: string | null; you: boolean; count: number }

// Where tickets come from and where mevo reports back: Linear or GitHub Issues. The core only
// uses this; the optional methods are Linear's extras (cycle, backlog search, projects, team
// counts, mentions) and the app hides what a tracker doesn't have.
export interface Tracker {
  readonly kind: TrackerKind
  // the name the app and the journal use: "Linear", "GitHub"
  readonly label: string
  onLabelColors: ((colors: Record<string, string>) => void) | null
  myOpenIssues(): Promise<readonly LinearIssue[]>
  humanComments(issueUuid: string): Promise<readonly LinearComment[]>
  // every comment with its id and thread, for requests and Night Shift
  threadComments(issueUuid: string): Promise<readonly ThreadComment[]>
  // an answer under a comment (in its thread where the tracker has threads)
  reply(issueUuid: string, parentId: string, body: string): Promise<string | null>
  createIssue(title: string, description: string): Promise<{ id: string; url: string }>
  issueView(issueUuid: string): Promise<LinearIssueView>
  lookup(input: string): Promise<{ found: FoundIssue; issue: LinearIssue } | null>
  comment(issueUuid: string, body: string): Promise<string | null>
  states(uuids: readonly string[]): Promise<Map<string, { name: string; type: string; links: readonly string[] }>>
  linkPr(issueUuid: string, url: string, title: string): Promise<void>
  moveToState(issueUuid: string, stateName: string): Promise<void>
  download(url: string): Promise<{ bytes: Buffer; type: string } | null>
  assignToMe(ids: readonly string[]): Promise<{ assigned: string[]; failed: { id: string; error: string }[] }>
  cycleView?(): Promise<CycleView>
  find?(scope: FindScope, opts: { query?: string; project?: string; team?: string }): Promise<readonly FoundIssue[]>
  projects?(query?: string): Promise<readonly LinearProject[]>
  projectByLink?(input: string): Promise<LinearProject | null>
  startedNow?(): Promise<Count[]>
  doneSince?(since: string): Promise<Count[]>
  mentionedPrs?(): Promise<readonly { url: string; issue: string; by: string; at: string }[]>
}

export const NO_CYCLE: CycleView = { cycle: null, issues: [] }
