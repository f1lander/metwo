export type TicketStatus =
  | 'assigned' // seen in Linear, waiting for a decision
  | 'queued' // decided, waiting for a free slot
  | 'running' // a lane is working in its worktree
  | 'needs_input' // the lane stopped with a question
  | 'review_ready' // commits exist locally, waiting for push approval
  | 'no_change' // the lane found nothing to change (already fixed, out of scope); you decide
  | 'pr_draft' // pushed and draft PR open
  | 'stopped' // you stopped it (or the daemon went down) mid-run; RESUME.md says where it was
  | 'done'
  | 'skipped'
  | 'failed'

export type Lane = 'lite' | 'full'
export type Decision = 'auto' | 'ask' | 'manual'

export interface TicketEvent {
  readonly at: string
  readonly kind: string
  readonly message: string
}

export interface PrComment {
  readonly id: string
  readonly kind: 'issue' | 'review' | 'inline'
  readonly author: string
  readonly body: string
  readonly path?: string
  readonly line?: number
  readonly url: string
  readonly createdAt: string
  readonly bot?: boolean
}

export interface PrInfo {
  readonly number: number
  readonly url: string
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly isDraft: boolean
  readonly ci: 'none' | 'pending' | 'success' | 'failure'
  readonly reviewDecision: string
  readonly comments: readonly PrComment[]
  readonly syncedAt: string
  readonly greptile?: GreptileReview
  readonly body?: string
  readonly head?: string
  readonly headSha?: string
  readonly labels?: readonly string[]
  // who opened the PR (you, for your tickets); their own comments are not "to address"
  readonly author?: string
}

// What the ticket page shows from Linear: the issue as people see it there.
export interface LinearIssueView {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly description: string
  readonly state: string
  readonly priority: string
  readonly assignee: string | null
  readonly creator: string
  readonly labels: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly comments: readonly { readonly author: string; readonly body: string; readonly createdAt: string; readonly bot: boolean }[]
}

export interface PrView {
  // 'github' = the live PR body, 'draft' = what metwo will open it with (not pushed yet)
  readonly source: 'github' | 'draft'
  readonly body: string
  readonly url: string | null
  readonly media: readonly { readonly name: string; readonly kind: 'image' | 'video'; readonly local: boolean }[]
}

export interface GreptileFinding {
  readonly level: string | null // P0..P3
  readonly title: string
  readonly body: string
  readonly path?: string
  readonly line?: number
  readonly url?: string
}

// The latest Greptile summary on the PR. `key` changes whenever Greptile posts or rewrites it.
export interface GreptileReview {
  readonly key: string
  readonly score: number | null
  readonly impact: string | null
  readonly findings: readonly GreptileFinding[]
  readonly url: string
  readonly at: string
}

export interface Failure {
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly hint: string
  readonly retryable: boolean
}

export type JournalKind = 'run' | 'review' | 'question' | 'answer' | 'ready' | 'no_change' | 'pr' | 'failure' | 'linear' | 'comment' | 'note'

// The per-ticket log of everything done on it: lane turns with their cost, hand-offs,
// Linear moves, the comments posted, and the operator's own notes.
export interface JournalEntry {
  readonly at: string
  readonly kind: JournalKind
  readonly title: string
  readonly body?: string
  readonly meta?: Readonly<Record<string, string | number>>
}

export interface Ticket {
  readonly id: string // WEB-1780
  readonly uuid: string
  readonly title: string
  readonly description: string
  readonly url: string
  readonly branch: string
  readonly labels: readonly string[]
  readonly priority: number
  readonly estimate: number | null
  readonly linearState: string
  readonly createdBy: string
  readonly seenAt: string
  readonly updatedAt: string

  readonly status: TicketStatus
  readonly decision: Decision
  readonly suggestedLane: Lane
  readonly reason: string
  readonly lane?: Lane
  readonly worktree?: string
  readonly port?: number
  readonly sessionId?: string
  readonly question?: string
  readonly summary?: string
  readonly diffStat?: string
  readonly commits?: string
  readonly prUrl?: string
  readonly pr?: PrInfo
  readonly error?: string
  readonly failure?: Failure
  readonly events: readonly TicketEvent[]
  readonly journal?: readonly JournalEntry[]
  // the model id claude actually ran (e.g. claude-opus-5-5), from the stream's init event
  readonly model?: string
  readonly effort?: string
  readonly gistId?: string
  readonly greptileFixing?: boolean
  // started with "max": the full lane at max effort, only when asked for
  readonly maxEffort?: boolean
  // the last commit metwo pushed, to tell your own pushes from the lane's
  readonly pushedSha?: string
  readonly lastPushAt?: string
  // implementer engine for this ticket ("codex", "claude:opus"...); unset = the lane's default
  readonly engine?: string
  // which engine owns sessionId: a session is only resumed by the engine that made it
  readonly sessionEngine?: string
  readonly supervision?: SupervisionReport
  // visual testing: auto-detected need (diff touches rendered files), your override, freshness
  readonly visualNeeded?: boolean
  readonly visualOverride?: 'on' | 'off'
  readonly visualAt?: string
  readonly visualStale?: boolean
  readonly visualPostedAt?: string
  // teammates' comments the lane is answering, replied to on GitHub when you push the fix
  readonly pendingReplies?: readonly { readonly id: string; readonly kind: 'issue' | 'review' | 'inline'; readonly author: string; readonly body: string; readonly url: string }[]
  readonly visual?: VisualReport
  // what was interrupted and the status to go back to (a visual check keeps the PR status)
  readonly stopped?: { readonly task: 'lane' | 'visual' | 'queued'; readonly from: TicketStatus; readonly at: string; readonly reason: string }
  // how far origin/<base> moved ahead of this branch, checked every few minutes
  readonly behindMain?: { readonly commits: number; readonly conflicts: boolean; readonly at: string }
  // the classifier's call: a quick fix autopilot may take on its own
  readonly small?: boolean
  // started by autopilot; `held` says why it stopped before the PR
  readonly autopilot?: { readonly at: string; readonly held?: string }
  // changes an agent proposes to the PR description (checklists, known gaps) for you to approve
  readonly descProposal?: DescProposal
  // what the lane is doing right now and since when; `phase` drives the stepper
  readonly stage?: { readonly name: string; readonly phase: StagePhase; readonly at: string }
  // stop at the next checkpoint (before the review pass or the supervisor) instead of going on
  readonly pauseAfter?: boolean
  // your instruction sent while a lane ran: it goes to the lane as soon as this run comes back
  readonly queuedInstruction?: { readonly text: string; readonly images: readonly string[]; readonly at: string } | null
  // a push in progress (each step) or the reason the last one failed
  readonly pushing?: { readonly at: string; readonly step: string; readonly error?: string }
  // a QA round on the PR's preview deploy, against the ticket and the PR's checklists
  readonly previewQa?: PreviewQa
  // PR comments you dealt with: sent to the lane, answered, or set aside
  readonly commentsHandled?: Readonly<Record<string, { readonly at: string; readonly how: 'addressed' | 'replied' | 'ignored' }>>
}

// Teammates' PR comments you have not dealt with yet.
// Deploy bots, review bots and CI post as apps whose login GitHub does not always mark as a bot.
const BOT_LOGINS = /(\[bot\]$|^cloudflare-|^vercel|^netlify|^github-actions|^greptile|^coderabbit|^codecov|^sonarcloud|^dependabot|^renovate|^changeset-bot|^linear$)/i
const BOT_BODY = /^(<!--|## Deploying|##+ .*Preview|\| *Status *\||Preview URL|<img alt="Cloudflare)/i

export function isBotComment(c: Pick<PrComment, 'author' | 'body' | 'bot'>): boolean {
  return Boolean(c.bot) || BOT_LOGINS.test(c.author) || BOT_BODY.test(c.body.trim())
}

// Teammates' PR comments you have not dealt with yet: no bots, not your own, not a bare
// "@greptile" tag. Before comments were picked one by one, a fix pass took everything up to then.
export function openComments(t: Ticket): readonly PrComment[] {
  const lastPass = t.commentsHandled ? '' : ([...t.events].reverse().find((e) => e.kind === 'fix-comments' && /comment/.test(e.message ?? ''))?.at ?? '')
  const me = t.pr?.author
  return (t.pr?.comments ?? []).filter((c) => !isBotComment(c) && c.author !== me && !/^@\w+\s*$/.test(c.body.trim()) && !t.commentsHandled?.[c.id] && c.createdAt > lastPass)
}

export type StagePhase = 'implementing' | 'review' | 'checks' | 'ready' | 'other'

export interface PreviewQa {
  readonly status: 'running' | 'done' | 'failed'
  readonly at: string
  readonly url: string
  // the commit the preview was built from, and whether it is the PR's head
  readonly sha: string | null
  readonly verdict?: 'pass' | 'partial' | 'fail'
  readonly summary?: string
  readonly checks?: VisualReport['checks']
  readonly error?: string
  readonly postedAt?: string
}

export interface DescChange {
  readonly id: string
  // the line as it is in the PR description now, and what it becomes
  readonly from: string
  readonly to: string
  readonly why: string
}

export interface DescProposal {
  readonly status: 'preparing' | 'ready' | 'failed'
  readonly trigger: 'visual' | 'manual'
  readonly at: string
  readonly sha: string
  readonly changes: readonly DescChange[]
  // one line for the description's Updates log, and an optional short comment
  readonly log: string
  readonly comment: string
  readonly error?: string
}

// A PR someone asked you to review (GitHub request or mention, a Linear comment, or added by hand).
// metwo checks it out read-only, runs the gates and the app, and drafts findings; nothing reaches
// GitHub until you pick what to post.
export type ReviewStatus = 'new' | 'queued' | 'reviewing' | 'reviewed' | 'posted' | 'stopped' | 'failed' | 'dismissed' | 'closed'

export interface ReviewFinding {
  readonly id: string
  readonly severity: string // P0..P3
  readonly title: string
  readonly body: string
  readonly file?: string
  readonly line?: number
  readonly suggestion?: string
  // the line is inside the diff, so it can be an inline comment
  readonly inline?: boolean
}

export interface ReviewReport {
  readonly verdict: 'approve' | 'comment' | 'request_changes'
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
  readonly checks: readonly { readonly what: string; readonly result: 'pass' | 'fail' | 'not_checked'; readonly shot?: string; readonly note?: string }[]
  readonly gates: readonly { readonly name: string; readonly ok: boolean; readonly tail: string }[]
  readonly engine: string
  readonly sha: string
  readonly at: string
}

export interface PrReview {
  readonly id: string // PR-1625
  readonly number: number
  readonly repo: string // owner/name
  readonly url: string
  readonly title: string
  readonly author: string
  readonly body: string
  readonly head: string
  readonly headSha: string
  readonly base: string
  readonly isDraft: boolean
  readonly source: 'requested' | 'mentioned' | 'linear' | 'manual'
  readonly sourceNote: string
  readonly requestedAt: string
  readonly updatedAt: string
  readonly status: ReviewStatus
  readonly worktree?: string
  readonly port?: number
  readonly report?: ReviewReport
  // the PR moved since the report was written
  readonly stale?: boolean
  readonly posted?: { readonly url: string; readonly at: string; readonly event: string; readonly comments: number }
  readonly error?: string
  readonly journal?: readonly JournalEntry[]
}

export interface LearningProposal {
  readonly id: string
  readonly rule: string
  readonly area: string
  readonly why: string
  readonly sources: readonly string[]
  readonly status: 'proposed' | 'approved' | 'rejected'
  readonly at: string
  readonly engine: string
}

// A second engine's check of a finished issue (SUPERVISE.json, plus metwo's own gate re-run).
export interface SupervisionReport {
  readonly verdict: 'pass' | 'concerns' | 'fail'
  readonly engine: string
  readonly summary: string
  readonly criteria: readonly { readonly criterion: string; readonly met: boolean; readonly evidence: string }[]
  readonly findings: readonly { readonly severity: string; readonly file?: string; readonly note: string }[]
  readonly gates: readonly { readonly name: string; readonly ok: boolean; readonly tail: string }[]
  readonly round: number
  readonly at: string
}

// The lane's own account of the visual check (VISUAL.json in the flow dir).
export type VisualVerdict = 'verified' | 'partial' | 'not_verified' | 'not_applicable'
export interface VisualReport {
  readonly verdict: VisualVerdict
  readonly summary: string
  readonly checks: readonly { readonly what: string; readonly result: 'pass' | 'fail' | 'not_checked'; readonly shot?: string; readonly note?: string }[]
  readonly viewports?: readonly string[]
}

export interface MediaFile {
  // shots from the visual run before the latest one, served as prev--<name>
  readonly previous?: boolean
  readonly name: string
  readonly kind: 'image' | 'video'
  readonly bytes: number
  readonly at: string
}

export interface CycleIssue {
  readonly id: string
  readonly uuid: string
  readonly title: string
  readonly url: string
  readonly state: string
  readonly priority: number
  readonly priorityLabel: string
  readonly estimate: number | null
  readonly labels: readonly string[]
  readonly description?: string
  readonly updatedAt?: string
}

// An AI read of an issue: how big, what kind, how risky, and whether autopilot can take it.
export interface Triage {
  readonly size: 'XS' | 'S' | 'M' | 'L'
  readonly kind: 'ui' | 'logic' | 'copy' | 'bug' | 'infra' | 'other'
  readonly risk: 'low' | 'medium' | 'high'
  readonly easy: boolean
  readonly why: string
  readonly at: string
  // the issue's updatedAt when it was read; a newer edit in Linear reads it again
  readonly stamp: string
}

// Things the app can do for you; buttons, Telegram and the assistant all go through these.
export type AssistAction =
  | { readonly type: 'start'; readonly id: string; readonly lane: 'lite' | 'full' }
  | { readonly type: 'take'; readonly ids: readonly string[] }
  | { readonly type: 'review'; readonly id: string }
  | { readonly type: 'visual'; readonly id: string }
  | { readonly type: 'preview_qa'; readonly id: string }
  | { readonly type: 'update_main'; readonly id: string }
  | { readonly type: 'address_comments'; readonly id: string }
  | { readonly type: 'resume'; readonly id: string }
  | { readonly type: 'triage' }

export interface TodayItem {
  readonly key: string
  readonly group: 'now' | 'reviews' | 'pick'
  readonly id: string
  readonly title: string
  readonly why: string
  readonly tone: 'bad' | 'warn' | 'accent' | 'ok' | 'neutral'
  // where it lives in the app, and the one button that moves it forward
  readonly href: 'ticket' | 'review' | 'cycle'
  readonly action?: { readonly label: string; readonly do: AssistAction }
  readonly triage?: Triage
}

export interface AskReply {
  readonly answer: string
  // tickets, PRs or cycle issues to show as cards under the answer
  readonly ids: readonly string[]
  readonly plan: readonly { readonly action: AssistAction; readonly why: string }[]
}

export interface CycleView {
  readonly cycle: { readonly name: string; readonly number: number; readonly endsAt: string } | null
  readonly issues: readonly CycleIssue[]
}

// What a start button asks for: the two lanes, or the full lane at max effort.
export type StartChoice = Lane | 'max'

// how hard every lane and the review pass think, unless a ticket is started with max
export type Effort = 'low' | 'medium' | 'high'

// What you change in Settings, saved in state.json; it wins over ticketflow.config.json.
// which lanes go to your flat-plan or free engines before spending API-priced Claude
export type PlanFirst = 'off' | 'lite' | 'all'

export interface Settings {
  readonly maxParallel?: number
  readonly effort?: Effort
  readonly paused?: boolean
  readonly autopilot?: { readonly enabled?: boolean; readonly autoPush?: boolean; readonly maxPerDay?: number; readonly since?: string }
  readonly triage?: { readonly auto?: boolean }
  readonly budget?: { readonly daily?: number | null; readonly monthly?: number | null; readonly regulate?: boolean; readonly fallback?: string; readonly planFirst?: PlanFirst }
  readonly engines?: {
    readonly codex?: { readonly enabled?: boolean; readonly model?: string }
    readonly cursor?: { readonly enabled?: boolean; readonly model?: string }
    readonly opencode?: { readonly enabled?: boolean; readonly model?: string }
    readonly hermes?: { readonly enabled?: boolean; readonly provider?: string; readonly model?: string }
  }
  readonly roles?: {
    readonly implementer?: { readonly lite?: string; readonly full?: string }
    readonly reviewer?: string
    readonly supervisor?: string
    readonly supervisorRounds?: number
    readonly visual?: string
    readonly curator?: string
  }
  // highest budget alert sent per period ("day:2026-10-30" → 80)
  readonly alerts?: Readonly<Record<string, number>>
}

// The Settings page: your overrides, what is in effect, and the config file's values to reset to.
export interface SettingsValues {
  readonly autopilot: { readonly enabled: boolean; readonly autoPush: boolean; readonly maxPerDay: number }
  readonly triage: { readonly auto: boolean }
  readonly budget: { readonly daily: number | null; readonly monthly: number | null; readonly regulate: boolean; readonly fallback: string; readonly planFirst: PlanFirst }
  readonly engines: {
    readonly codex: { readonly enabled: boolean; readonly model: string }
    readonly cursor: { readonly enabled: boolean; readonly model: string }
    readonly opencode: { readonly enabled: boolean; readonly model: string }
    readonly hermes: { readonly enabled: boolean; readonly provider: string; readonly model: string }
  }
  readonly roles: { readonly implementer: { readonly lite: string; readonly full: string }; readonly reviewer: string; readonly supervisor: string; readonly supervisorRounds: number; readonly visual: string; readonly curator: string }
  readonly pipeline: { readonly effort: Effort; readonly maxParallel: number }
}
export interface SettingsView {
  readonly overrides: Settings
  readonly effective: SettingsValues
  readonly defaults: SettingsValues
}

// Where spend stands against the budget, and how lanes are being regulated because of it.
export type BudgetLevel = 'normal' | 'saver' | 'tight' | 'over'
export interface BudgetStatus {
  readonly level: BudgetLevel
  readonly regulate: boolean
  readonly day: { readonly spent: number; readonly limit: number | null }
  readonly month: { readonly spent: number; readonly limit: number | null }
  // the engine new lanes use at "over" (null: none enabled, so Claude only when you start a ticket)
  readonly fallback: string | null
}

export interface DaemonState {
  readonly tickets: Readonly<Record<string, Ticket>>
  readonly reviews?: Readonly<Record<string, PrReview>>
  readonly nextPortIndex: number
  // runtime overrides set from the app or Telegram; they win over the config file
  readonly settings?: Settings
  // spend outside tickets and reviews (triage, assistant questions), for the budget
  readonly spend?: readonly { readonly at: string; readonly what: string; readonly cost: number }[]
  // AI triage per issue id, for the cycle and your tickets
  readonly triage?: Readonly<Record<string, Triage>>
  // Linear label name → its color in Linear ("#bec2c8")
  readonly labelColors?: Readonly<Record<string, string>>
}

export type ServerEvent =
  | { readonly type: 'triage'; readonly triage: Readonly<Record<string, Triage>> }
  | { readonly type: 'labels'; readonly labelColors: Readonly<Record<string, string>> }
  | { readonly type: 'snapshot'; readonly state: DaemonState }
  | { readonly type: 'ticket'; readonly ticket: Ticket }
  | { readonly type: 'review'; readonly review: PrReview }
  | { readonly type: 'live'; readonly id: string; readonly line: LiveLine }

export interface LiveLine {
  readonly at: string
  readonly kind: 'text' | 'tool' | 'stage'
  readonly text: string
}

export interface CheckState {
  readonly ok: boolean | null // null = unknown / not checked yet
  readonly detail: string
  readonly at: string | null
}

export interface Health {
  readonly startedAt: string
  readonly pid: number
  readonly version: string
  readonly daemon: CheckState
  readonly telegram: CheckState & { readonly bot: string | null }
  readonly linear: CheckState & { readonly lastPollAt: string | null; readonly tracked: number }
  readonly github: CheckState
  readonly claude: CheckState
  readonly e2e: CheckState & { readonly ports: Readonly<Record<string, boolean>> }
  readonly tunnel: CheckState & { readonly url: string | null }
  readonly lanes: {
    readonly active: readonly string[]
    readonly max: number
    readonly paused: boolean
    // minutes without a single line from a lane before it counts as possibly stuck
    readonly stuckMinutes?: number
    readonly budget?: BudgetStatus
    readonly autopilot?: { readonly enabled: boolean; readonly autoPush: boolean; readonly maxPerDay: number; readonly today: number }
    readonly effort?: Effort
    readonly engines?: readonly { readonly id: string; readonly label: string; readonly installed: boolean; readonly signedIn: boolean | null; readonly version: string | null; readonly detail: string; readonly roles: readonly string[] }[]
    readonly models?: Readonly<Record<'lite' | 'full' | 'review', { readonly model: string; readonly effort: string }>>
  }
  readonly prSync: CheckState
  // fetching the base branch and counting how far open branches are behind
  readonly mainSync?: CheckState
  // finding PRs you were asked to review
  readonly reviews?: CheckState
  // the signed-in GitHub browser profile metwo uses to attach screenshots and videos
  readonly uploads?: CheckState & { readonly login: string | null }
}

export interface DiffFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: 'added' | 'deleted' | 'renamed' | 'modified'
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  readonly patch: string
  readonly truncated: boolean
}

export interface TicketDiff {
  readonly base: string
  readonly files: readonly DiffFile[]
  readonly added: number
  readonly removed: number
  readonly uncommitted: boolean
}

export interface Digest {
  readonly closed: readonly string[]
  readonly waiting: readonly string[]
  readonly running: readonly string[]
  readonly prsOpen: readonly string[]
  readonly costToday: number
  readonly lanesToday: number
}
export * from './text.js'
export * from './estimate.js'
