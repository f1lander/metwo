import type { MyThreadsSummary, PrConversation, PrThread } from './conversation.js'

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
  // GitHub's own merge check against the base branch
  readonly mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
}

// What the ticket page shows from Linear: the issue as people see it there.
export interface LinearPerson {
  readonly name: string
  readonly avatar: string | null
  // the GitHub user id linked in Linear
  readonly github: string | null
}

export interface LinearIssueView {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly description: string
  readonly state: string
  readonly priority: string
  readonly assignee: string | null
  readonly creator: string
  readonly creatorPerson?: LinearPerson
  readonly assigneePerson?: LinearPerson
  readonly labels: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly comments: readonly { readonly author: string; readonly body: string; readonly createdAt: string; readonly bot: boolean; readonly person?: LinearPerson }[]
}

export interface PrView {
  // 'github' = the live PR body, 'draft' = what mevo will open it with (not pushed yet)
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

// ask: a question you asked in the ticket chat and its answer, from the ticket's record, no lane
export type JournalKind = 'run' | 'review' | 'question' | 'answer' | 'ready' | 'no_change' | 'pr' | 'failure' | 'linear' | 'comment' | 'note' | 'ask'

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
  // the Linear user who opened it: their GitHub id (for the GitHub avatar) and Linear avatar
  readonly creator?: LinearPerson
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
  // the change's size as a reviewer reads it, lockfiles and snapshots left out
  readonly size?: PrSize
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
  // pstack principles for this ticket: unset follows Settings
  readonly principles?: boolean
  // the last commit mevo pushed, to tell your own pushes from the lane's
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
  readonly behindMain?: { readonly commits: number; readonly conflicts: boolean; readonly at: string; readonly files?: readonly string[] }
  // the PR was closed (not merged) on GitHub, so the board closed the ticket; a reopen there brings it back
  readonly closedOnGithub?: { readonly at: string; readonly by: string | null }
  // the PR branch on GitHub has commits the worktree doesn't (main merged there, a teammate's push)
  readonly behindPr?: { readonly sha: string; readonly commits: number; readonly at: string; readonly why: 'busy' | 'diverged' | 'conflicts' | 'error'; readonly detail?: string; readonly files?: readonly string[] }
  // a merge of main you are resolving by hand in your editor: the conflicted files, and those still unresolved
  // the head commit whose Storybook stories are listed in the PR body
  readonly storiesSha?: string
  readonly manualMerge?: { readonly at: string; readonly files: readonly string[]; readonly left: readonly string[] }
  // main merged into the PR branch by GitHub's "Update branch" (no lane); cleared when the new head shows up
  readonly githubUpdate?: { readonly at: string; readonly from: string | null }
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
  // the steps a person follows to test it by hand, and the runs: a certificate per run
  readonly testPlan?: TestPlan
  readonly humanTests?: readonly HumanTestRun[]
  // a question in the chat being answered (read-only, no lane)
  readonly asking?: { readonly at: string; readonly question: string; readonly error?: string }
  // a push in progress (each step) or the reason the last one failed
  readonly pushing?: { readonly at: string; readonly step: string; readonly error?: string }
  // why CI is red on the PR: failing jobs, their log tails, and whether it looks like this change
  readonly ci?: CiDiagnosis
  // a QA round on the PR's preview deploy, against the ticket and the PR's checklists
  readonly previewQa?: PreviewQa
  // PR comments you dealt with: sent to the lane, answered, or set aside
  // commits: the local commits that addressed it (short shas)
  readonly commentsHandled?: Readonly<Record<string, { readonly at: string; readonly how: 'addressed' | 'replied' | 'ignored'; readonly commits?: readonly string[] }>>
  // closed a while ago: the full record (journal texts, PR comments, checks) is in data/archive/<id>.json
  readonly archived?: string
  // the last quick fix: what the owner checks by hand (from the lane), and whether they did
  readonly quickCheck?: { readonly at: string; readonly steps: readonly string[]; readonly done?: string }
  // commits here the PR on GitHub doesn't have yet: the PR still shows the code before them
  readonly unpushed?: { readonly count: number; readonly commits: readonly { readonly sha: string; readonly subject: string }[]; readonly at: string }
  // "Analyze first" on PR comments: does each one make sense, what to change, or what to answer
  readonly commentTriage?: Readonly<Record<string, CommentTriage>>
  // "Analyze first" while it runs (the step it is on), or why the last one failed
  readonly triaging?: { readonly at: string; readonly step: string; readonly ids: readonly string[]; readonly error?: string }
  // a cheap read of the ticket and its Linear discussion before any work starts
  readonly readiness?: Readiness
  readonly localChecks?: LocalChecks
  // review threads, reviewers and re-review requests on the PR, as GitHub has them
  readonly conversation?: PrConversation
  // the reviewers you nudged on Slack, by GitHub login (lower case)
  readonly nudges?: Readonly<Record<string, { readonly at: string; readonly to: string }>>
  readonly readinessRunning?: { readonly at: string; readonly error?: string }
}

export interface CommentTriage {
  readonly verdict: 'valid' | 'partly' | 'disagree' | 'question'
  readonly why: string
  // what to change, as a note for the lane
  readonly plan?: string
  // a reply you can post instead of, or as well as, the change
  readonly reply?: string
  readonly at: string
}

// One review comment on your PRs and how it ended: the team's review knowledge.
export interface FixEntry {
  // PR-<number>:<comment id>
  readonly id: string
  readonly pr: number
  readonly prUrl: string
  readonly prTitle: string
  readonly ticket: string | null
  readonly source: 'teammate' | 'greptile'
  readonly reviewer: string
  readonly file?: string
  readonly line?: number
  readonly comment: string
  readonly verdict: 'fixed' | 'declined' | 'answered' | 'open'
  // what was changed, or why not
  readonly resolution: string
  // a few lines of the code after the fix
  readonly snippet?: string
  readonly commit?: string
  readonly tags: readonly string[]
  readonly at: string
}

export interface FixLogView {
  readonly entries: readonly FixEntry[]
  readonly prs: number
  readonly reviewers: readonly { readonly login: string; readonly count: number; readonly topics: readonly string[] }[]
  readonly learning: { readonly running: boolean; readonly done: number; readonly total: number; readonly current: number | null; readonly errors: readonly string[] }
}

// How to install and sign in to each engine's CLI on the Mac. `login` is interactive, so it
// runs in your terminal; the install runs from mevo.
export const ENGINE_SETUP: Readonly<Record<string, { readonly install: string; readonly login: string | null; readonly loginHint?: string }>> = {
  claude: { install: 'npm i -g @anthropic-ai/claude-code', login: 'claude', loginHint: 'then type /login' },
  codex: { install: 'npm i -g @openai/codex', login: 'codex login' },
  cursor: { install: 'curl https://cursor.com/install -fsS | bash', login: 'agent login' },
  opencode: { install: 'npm i -g opencode-ai', login: 'opencode auth login' },
  hermes: { install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', login: null },
}

export interface EngineSetupStatus {
  readonly id: string
  readonly state: 'installing' | 'done' | 'failed'
  readonly at: string
  // the last lines of the install's output
  readonly output: string
}

// The choices in a lane's question: the numbered list under "Options:" (or the last numbered
// list), each with a short label (its bold part, or its first words) for a button.
export interface QuestionOption {
  readonly n: number
  readonly label: string
  readonly text: string
  readonly recommended: boolean
}
export function questionOptions(question: string | undefined): readonly QuestionOption[] {
  if (!question) return []
  const lines = question.split('\n')
  const at = lines.findIndex((l) => /^\s*\**options?\**\s*:?\s*\**\s*$/i.test(l.replace(/^#+\s*/, '')))
  const from = at >= 0 ? at + 1 : 0
  const out: QuestionOption[] = []
  for (const line of lines.slice(from)) {
    const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)
    if (m) {
      const text = (m[2] ?? '').trim()
      const bold = /\*\*(.+?)\*\*/.exec(text)?.[1]
      const recommended = /\(recommended\)/i.test(text)
      const raw = (bold ?? text.split(/[.:;—]\s/)[0] ?? text).replace(/\(recommended\)/i, '').replace(/[*`]/g, '').trim().replace(/[.:]$/, '').trim()
      out.push({ n: Number(m[1]), label: raw.length > 70 ? `${raw.slice(0, 67)}…` : raw, text: text.replace(/\*\*/g, ''), recommended })
    } else if (out.length && line.trim() && !/^\s{2,}/.test(line)) break
  }
  return out.length >= 2 && out.length <= 8 ? out : []
}

// A red CI on the PR, read without AI: the failing jobs, the end of their logs, whether the
// same check is red on the base branch, and which of this PR's files the log mentions.
export type CiVerdict = 'ours' | 'main' | 'flaky' | 'unclear'
export interface CiJob {
  readonly name: string
  readonly workflow: string
  readonly url: string
  readonly runId: string | null
  readonly tail: string
  readonly files: readonly string[]
  readonly onMain: boolean
  readonly infra: boolean
}
export interface CiDiagnosis {
  readonly at: string
  readonly sha: string | null
  readonly verdict: CiVerdict
  readonly why: string
  readonly jobs: readonly CiJob[]
  readonly error?: string
}

// A failed run whose implementer turn finished: the checks can run again without redoing the work.
export function canFinishChecks(t: Ticket): boolean {
  if (t.status !== 'failed' || !t.worktree) return false
  const since = [...t.events].reverse().find((e) => e.kind === 'start' || e.kind === 'resume')?.at ?? ''
  return t.events.some((e) => e.kind === 'lane' && e.at >= since)
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
  // checks: an agent worked the PR's unticked checks (verified what it could, guides you through the rest)
  readonly trigger: 'visual' | 'manual' | 'checks'
  readonly at: string
  readonly sha: string
  readonly changes: readonly DescChange[]
  // one line for the description's Updates log, and an optional short comment
  readonly log: string
  readonly comment: string
  readonly error?: string
  // unticked checks only you can do, each with how to do it (trigger checks)
  readonly guide?: readonly CheckGuide[]
}

export interface CheckGuide {
  // the checkbox line as it is in the PR description
  readonly line: string
  readonly why: string
  readonly steps: readonly string[]
}

// A checkbox in a PR description and the heading it sits under.
export interface PrCheck {
  readonly line: string
  readonly text: string
  readonly section: string
  readonly done: boolean
  // under Human Testing Required: yours to do, never ticked by an agent
  readonly human: boolean
}

export function prChecks(body: string): PrCheck[] {
  let h2 = ''
  let h3 = ''
  const out: PrCheck[] = []
  for (const line of body.split('\n')) {
    const m2 = /^##\s+(.+)/.exec(line)
    const m3 = /^###\s+(.+)/.exec(line)
    if (m2 && !line.startsWith('###')) {
      h2 = (m2[1] ?? '').trim()
      h3 = ''
      continue
    }
    if (m3) {
      h3 = (m3[1] ?? '').trim()
      continue
    }
    const box = /^\s*[-*] \[([ xX])\]\s+(.*)$/.exec(line)
    if (!box) continue
    out.push({ line, text: (box[2] ?? '').trim(), section: h3 ? `${h2} › ${h3}` : h2, done: box[1] !== ' ', human: /human testing/i.test(h2) })
  }
  return out
}

// A PR someone asked you to review (GitHub request or mention, a Linear comment, or added by hand).
// mevo checks it out read-only, runs the gates and the app, and drafts findings; nothing reaches
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

export type ReviewDepth = 'code' | 'full'

// An open, ready-for-review PR in the repo that is not yours, for picking what to review.
export interface OpenPr {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly author: string
  readonly updatedAt: string
  readonly head: string
  readonly labels: readonly string[]
  readonly additions: number
  readonly deletions: number
  readonly files: number
  // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty
  readonly reviewDecision: string
  // your review was requested on GitHub
  readonly requested: boolean
  // already on your review list: its id
  readonly review: string | null
}

export interface ReviewReport {
  readonly depth?: ReviewDepth
  // what the reviewer could not do itself (a wallet signature, a real device), with steps for you
  readonly manual?: readonly { readonly what: string; readonly why: string; readonly steps: readonly string[] }[]
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
  readonly source: 'requested' | 'mentioned' | 'linear' | 'manual' | 'picked'
  // code: read the diff only, nothing runs (cheap). full: install, gates, the app in a browser.
  readonly depth?: ReviewDepth
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
  // after you posted: what the author did with your comments
  readonly followUp?: ReviewFollowUp
  readonly error?: string
  readonly journal?: readonly JournalEntry[]
}

export type ThreadVerdict = 'addressed' | 'partly' | 'not_addressed' | 'answered'

export interface ReviewFollowUp {
  readonly at: string
  // the PR head when this was read
  readonly sha: string
  // the commit your review was on
  readonly reviewedSha: string
  readonly commitsSince: number
  readonly summary: MyThreadsSummary
  readonly threads: readonly (PrThread & { readonly verdict?: ThreadVerdict; readonly note?: string; readonly reply?: string })[]
  // a model read the new commits against your open threads
  readonly checked?: { readonly at: string; readonly sha: string; readonly engine: string; readonly cost?: number; readonly summary: string }
  readonly checking?: boolean
  readonly pinged?: { readonly at: string; readonly to: string }
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

// Is the ticket ready for a lane? Read from the description and the whole Linear discussion.
export interface Readiness {
  // ready: clear enough to start; clarify: open questions; hold: done elsewhere, blocked or not now
  readonly verdict: 'ready' | 'clarify' | 'hold'
  // 0-100: how sure an agent can finish it as asked without asking anyone
  readonly confidence: number
  readonly why: string
  // what to build, latest decisions first
  readonly scope: readonly string[]
  readonly questions: readonly string[]
  // decisions in the comments that change the description
  readonly decisions: readonly string[]
  readonly engine: string
  readonly comments: number
  readonly at: string
  // the text it read; a changed description or a new comment reads it again
  readonly stamp: string
  readonly cost?: number
}

// A hand test: steps a person does in a real browser while mevo watches. Each step has a check
// mevo can see on its own (a URL, text on the page, a wallet call, a transaction, the clipboard)
// or is marked by the tester ('manual').
export type TestCheckKind = 'url' | 'text' | 'selector' | 'rpc' | 'tx' | 'clipboard' | 'manual'

export interface TestStep {
  readonly id: string
  readonly title: string
  // what to do, in one or two sentences
  readonly how: string
  // what should happen
  readonly expect: string
  readonly check: { readonly kind: TestCheckKind; readonly value?: string }
  // the route the panel takes you to when this step comes up ("/register/name.eth")
  readonly go?: string
}

export interface TestPlan {
  readonly at: string
  // the commit it was written for
  readonly sha: string
  readonly engine: string
  readonly steps: readonly TestStep[]
  // where these steps can be done: the local chain with the test wallet, the PR's preview, or
  // your own Chrome and wallet on the app from the worktree (Sepolia)
  readonly where?: 'mock' | 'preview' | 'chrome'
  readonly whereWhy?: string
}

// mock: the local chain with the test wallet · preview: the PR's preview in a clean Chromium ·
// chrome: your everyday Chrome (your MetaMask) on the app from the worktree on its own network
// (Sepolia), with the steps panel injected by a local proxy
export type HumanTestMode = 'mock' | 'preview' | 'chrome'

export interface HumanTestStepResult {
  readonly id: string
  readonly status: 'pending' | 'done' | 'failed' | 'skipped'
  readonly at?: string
  // auto: mevo saw it happen · manual: the tester marked it
  readonly how?: 'auto' | 'manual'
  readonly shot?: string
  readonly note?: string
  // what mevo saw: the URL, the tx hash, the copied text
  readonly detail?: string
}

export interface HumanTestRun {
  readonly id: string
  readonly mode: HumanTestMode
  readonly url: string
  readonly sha: string
  readonly tester: string
  readonly startedAt: string
  readonly endedAt?: string
  // incomplete: ended with steps neither done nor failed
  readonly status: 'starting' | 'running' | 'passed' | 'failed' | 'incomplete' | 'error'
  readonly steps: readonly HumanTestStepResult[]
  // the plan as it was for this run
  readonly plan: readonly TestStep[]
  readonly errors: readonly string[]
  readonly txs: readonly string[]
  readonly video?: string
  // more parts of the phone's screen recording, when they could not be joined
  readonly videos?: readonly string[]
  readonly detail?: string
  // the Android phone it ran on; none means a Chromium window on the Mac
  readonly device?: { readonly serial: string; readonly model: string; readonly android?: string; readonly chrome?: string }
  // the wallet is waiting for the tester to approve a transaction (mock wallet)
  // what the session says while it runs ("Test wallet connected: 0x…")
  readonly note?: string
  readonly pendingTx?: boolean
}

// An Android phone adb can see.
export interface AndroidDevice {
  readonly serial: string
  readonly model: string
  // unauthorized: the phone has not accepted this computer's USB debugging prompt yet
  readonly state: 'device' | 'unauthorized' | 'offline'
  readonly transport: 'usb' | 'wifi'
  readonly android?: string
  readonly chrome?: string
  // the screen in pixels, portrait
  readonly width?: number
  readonly height?: number
}

// A second engine's check of a finished issue (SUPERVISE.json, plus mevo's own gate re-run).
export interface SupervisionReport {
  readonly verdict: 'pass' | 'concerns' | 'fail'
  readonly engine: string
  readonly summary: string
  readonly criteria: readonly { readonly criterion: string; readonly met: boolean; readonly evidence: string }[]
  // P1/P2 need a proof (a command the supervisor ran and what it printed); without one they count as P3
  readonly findings: readonly { readonly severity: string; readonly file?: string; readonly note: string; readonly proof?: { readonly command: string; readonly output: string }; readonly unproven?: boolean }[]
  readonly gates: readonly { readonly name: string; readonly ok: boolean; readonly tail: string }[]
  readonly round: number
  readonly at: string
  // the commit the gates ran on
  readonly sha?: string
}

// What CI would run, run here before the PR: the gates and the e2e specs related to the change.
export interface LocalChecks {
  readonly sha: string
  readonly at: string
  readonly status: 'running' | 'pass' | 'fail'
  // the daemon had newer code on disk it had not loaded when these ran
  readonly staleDaemon?: boolean
  // what is running now (while running)
  readonly step?: string
  // ok: null = not run (skipped, stack down); a warning, not a failure
  readonly steps: readonly { readonly name: string; readonly ok: boolean | null; readonly tail: string; readonly note?: string; readonly seconds?: number }[]
  readonly specs?: readonly string[]
  // push once they pass (you pressed Push before they ran)
  readonly thenPush?: boolean
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

// Any Linear issue you can find: from the backlog, a project, a search or a pasted link.
export interface FoundIssue extends CycleIssue {
  readonly team: string
  readonly project: string | null
  readonly cycle: string | null
  readonly assignee: string | null
  readonly mine: boolean
  readonly done: boolean
}
export type FindScope = 'backlog' | 'project' | 'search' | 'mine'
export interface LinearProject {
  readonly id: string
  readonly name: string
  readonly teams: readonly string[]
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
  readonly readiness?: { readonly auto?: boolean; readonly engine?: string; readonly minConfidence?: number }
  readonly localChecks?: { readonly enabled?: boolean; readonly e2e?: 'related' | 'all' | 'off'; readonly e2eAfterPr?: boolean }
  readonly afterFix?: { readonly reply?: boolean; readonly resolve?: boolean; readonly rerequest?: boolean }
  readonly chat?: { readonly ask?: string }
  readonly principles?: { readonly enabled?: boolean; readonly ref?: string }
  readonly slack?: SlackSettings
  readonly figma?: { readonly enabled?: boolean }
  // Mo floating in the app instead of the Tell the agent button; coffee: the energy game that blocks new lanes when empty
  readonly mascot?: { readonly enabled?: boolean; readonly coffee?: boolean }
  // restart by itself when its code changed on disk and nothing is running (desktop app only)
  readonly daemon?: { readonly autoRestart?: boolean }
  // small, reviewable PRs. null = no limit
  readonly quality?: QualitySettings
  // pipeline switches that used to be config-file only
  readonly pipeline?: PipelineSettings
  // per AI step: effort, the context it gets and extra instructions
  readonly steps?: { readonly [K in StepId]?: StepSettings }
  // which screenshots and videos the lane takes, and which reach the PR
  readonly shots?: Partial<ShotRules>
  readonly github?: { readonly screenshots?: 'browser' | 'gist' | 'none'; readonly greptile?: { readonly enabled?: boolean }; readonly reviewers?: { readonly auto?: boolean; readonly max?: number } }
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
  readonly readiness: { readonly auto: boolean; readonly engine: string; readonly minConfidence: number }
  readonly localChecks: { readonly enabled: boolean; readonly e2e: 'related' | 'all' | 'off'; readonly e2eAfterPr: boolean }
  readonly afterFix: { readonly reply: boolean; readonly resolve: boolean; readonly rerequest: boolean }
  readonly chat: { readonly ask: string }
  readonly budget: { readonly daily: number | null; readonly monthly: number | null; readonly regulate: boolean; readonly fallback: string; readonly planFirst: PlanFirst }
  readonly engines: {
    readonly codex: { readonly enabled: boolean; readonly model: string }
    readonly cursor: { readonly enabled: boolean; readonly model: string }
    readonly opencode: { readonly enabled: boolean; readonly model: string }
    readonly hermes: { readonly enabled: boolean; readonly provider: string; readonly model: string }
  }
  readonly roles: { readonly implementer: { readonly lite: string; readonly full: string }; readonly reviewer: string; readonly supervisor: string; readonly supervisorRounds: number; readonly visual: string; readonly curator: string }
  readonly pipeline: { readonly effort: Effort; readonly maxParallel: number } & Required<PipelineSettings>
  readonly github: { readonly screenshots: 'browser' | 'gist' | 'none'; readonly greptile: { readonly enabled: boolean }; readonly reviewers: { readonly auto: boolean; readonly max: number } }
  readonly steps: { readonly [K in StepId]: StepValues }
  readonly shots: ShotRules
  readonly principles: { readonly enabled: boolean; readonly ref: string }
  readonly slack: Required<{ [K in keyof SlackSettings]-?: NonNullable<SlackSettings[K]> }>
  readonly figma: { readonly enabled: boolean }
  readonly mascot: { readonly enabled: boolean; readonly coffee: boolean }
  readonly daemon: { readonly autoRestart: boolean }
  readonly quality: { readonly targetLines: number | null; readonly maxLines: number | null; readonly minGreptile: number | null; readonly securityLens: boolean; readonly quick: string }
}

export interface PipelineSettings {
  // a second engine reads the finished work before the gates
  readonly reviewPass?: boolean
  // the first time a lane finishes with no PR yet, push and open the draft PR
  readonly draftOnFinish?: boolean
  // merge the base into open PRs that are behind and conflict free
  readonly autoUpdateFromMain?: boolean
  // fast-forward commits made on GitHub into the worktree
  readonly autoPullPr?: boolean
}

// The AI steps of the pipeline and what each one can be given. Every block is on by default.
export type StepId = 'implement' | 'review' | 'supervisor' | 'visual' | 'quick'
export type ContextBlock = 'linear' | 'slack' | 'figma' | 'readiness' | 'knowledge' | 'mcp' | 'principles' | 'learnings' | 'repoRules' | 'browser' | 'storybook' | 'video' | 'lenses' | 'feedback'
export const STEP_CONTEXT: { readonly [K in StepId]: readonly ContextBlock[] } = {
  implement: ['linear', 'slack', 'figma', 'feedback', 'readiness', 'knowledge', 'mcp', 'principles', 'learnings', 'repoRules', 'browser', 'storybook', 'video'],
  review: ['knowledge', 'lenses', 'repoRules', 'feedback'],
  supervisor: ['repoRules', 'figma', 'principles'],
  visual: ['figma'],
  quick: [],
}
export const CONTEXT_INFO: { readonly [K in ContextBlock]: { readonly label: string; readonly what: string } } = {
  linear: { label: 'Linear discussion', what: 'Comments on the issue and the images in it' },
  slack: { label: 'Slack threads', what: 'Slack threads linked in the ticket' },
  figma: { label: 'Figma', what: 'Frames linked in the ticket, as the design reference' },
  readiness: { label: 'Readiness read', what: "The readiness check's scope, decisions and open questions" },
  knowledge: { label: 'Team knowledge', what: 'The wiki and knowledge sources that match the ticket' },
  mcp: { label: 'Team MCP', what: 'Points the lane to the team MCP servers' },
  principles: { label: 'Engineering principles', what: 'pstack principles and the playbook (when they are on)' },
  learnings: { label: 'Team learnings', what: 'Rules you approved from past PR feedback' },
  repoRules: { label: 'Repo rules', what: 'CLAUDE.md, STYLEGUIDE.md, .greptile and the other agent files' },
  browser: { label: 'Browser check', what: 'Drive the app with Playwright to verify UI changes' },
  storybook: { label: 'Storybook', what: 'Add stories and screenshot them' },
  video: { label: 'Video', what: 'Record a short clip of the interaction' },
  lenses: { label: 'Review lenses', what: 'Principles and knowledge used as review lenses' },
  feedback: { label: 'Past PR feedback', what: 'What reviewers said before about the files touched' },
}
export interface ShotRules {
  // lane: the lane takes the screenshots itself · steps: it writes VISUAL-PLAN.json and mevo runs
  // it in a browser with the test wallet, takes the shots and records the video
  readonly mode: 'lane' | 'steps'
  // video speed after the waits are cut (steps mode)
  readonly speed: number
  // screenshots in all, stories and before shots included; also what reaches the PR
  readonly max: number
  // layout: mobile only when the layout changes
  readonly mobile: 'layout' | 'always' | 'never'
  // changed: a before shot only for states whose look changed
  readonly before: 'changed' | 'bugs' | 'never'
  // interactions: one short clip when a still can't show the change
  readonly video: 'interactions' | 'off'
  // story screenshots at most (they count in max)
  readonly stories: number
}
export interface StepSettings {
  // null: the global effort (for quick: low)
  readonly effort?: Effort | null
  readonly instructions?: string
  readonly context?: { readonly [K in ContextBlock]?: boolean }
}
export interface StepValues {
  readonly effort: Effort | null
  readonly instructions: string
  readonly context: { readonly [K in ContextBlock]?: boolean }
}
// What a step would get for one ticket, built without running anything.
export interface PromptPreview {
  readonly step: StepId
  readonly ticket: string
  readonly engine: string
  readonly effort: Effort
  readonly blocks: readonly { readonly id: string; readonly title: string; readonly chars: number; readonly context?: ContextBlock; readonly on: boolean }[]
  readonly text: string
  // what is added only when it runs (downloads, Figma), and what the preview had to guess
  readonly notes: readonly string[]
}

// The pipeline, stage by stage, as it runs now (config file + Settings). For the Pipeline tab and docs.
export type PipelineStageId = 'intake' | 'implement' | 'review' | 'beforePr' | 'pr' | 'followUps'
export interface PipelineStep {
  readonly label: string
  // what happens with the current values, in a few words
  readonly value: string
  readonly on: boolean
  // where it lives in the stages config block, e.g. "review.supervisor.engine"
  readonly key: string
  // changeable in Settings (otherwise the config file only)
  readonly setting: boolean
}
export interface PipelineStage {
  readonly id: PipelineStageId
  readonly title: string
  readonly what: string
  readonly steps: readonly PipelineStep[]
}
export interface PipelineView {
  readonly stages: readonly PipelineStage[]
  // true when ticketflow.config.json uses the stages block
  readonly staged: boolean
}

export interface QualitySettings {
  // lines a lane aims for; it splits bigger work into follow-ups
  readonly targetLines?: number | null
  // over it the PR is not marked ready for review and autopilot holds
  readonly maxLines?: number | null
  // Greptile score (1-5) a PR needs before it is marked ready
  readonly minGreptile?: number | null
  // an extra security review when the diff touches signing, transactions, auth or HTML
  readonly securityLens?: boolean
  // engine:model for quick fixes
  readonly quick?: string
}

export interface PrSize {
  // added + removed, without the files config quality.sizeIgnore leaves out
  readonly lines: number
  readonly files: number
  // the part in tests and stories
  readonly tests: number
  readonly at: string
}

// Slack, each part on its own switch.
export interface SlackSettings {
  // read Slack thread links in tickets and PRs as context for the lane
  readonly threads?: boolean
  // DM you what Telegram sends (needs SLACK_BOT_TOKEN and SLACK_USER_ID)
  readonly notify?: boolean
  // post a PR to a channel when it is marked ready for review
  readonly announce?: boolean
  // channel id (C0123…) or name (#web-prs)
  readonly channel?: string
  // read threads where you were tagged and summarize them (needs SLACK_USER_TOKEN)
  readonly mentions?: boolean
  // "HH:MM" on weekdays: your PRs waiting for review, posted to the channel; '' = only when you press it
  readonly reviewSummaryAt?: string
  // Roll call: your PRs waiting for review, posted on a schedule (replaces reviewSummaryAt)
  readonly rollCalls?: readonly RollCall[]
  // due nudges go out by themselves, in the reviewer's working hours, once a day at most
  readonly autoNudge?: boolean
  readonly nightShift?: Partial<NightShiftConfig>
}

export interface RollCall {
  // "HH:MM" in this computer's time zone
  readonly at: string
  readonly days: 'weekdays' | 'daily'
  // empty: the Slack channel above
  readonly channel?: string
}

// A Slack message that tagged you, with the thread read and summarized.
export interface SlackMention {
  readonly id: string
  readonly channel: string
  readonly channelName: string
  readonly ts: string
  readonly threadTs: string
  readonly permalink: string
  readonly from: string
  readonly text: string
  readonly at: string
  readonly status: 'new' | 'summarizing' | 'ready' | 'done' | 'failed'
  readonly summary?: string
  // what mevo thinks you should do: nothing, reply, review a PR, look at a ticket
  readonly action?: { readonly kind: 'none' | 'reply' | 'review' | 'ticket' | 'other'; readonly what: string; readonly reply?: string; readonly links?: readonly string[] }
  readonly error?: string
  // came in during Night Shift: how mevo read it and what its bot would answer
  readonly night?: NightReply
  // made by Test Night Shift: it lives in your DM with the bot
  readonly test?: boolean
  // written by an app or bot, not a person: Night Shift never answers it by itself
  readonly fromBot?: boolean
  // the Slack user who wrote it, when a person did
  readonly fromId?: string
}

// A Slack channel you could post to; bot: the bot is in it (it can only post where it was invited)
export interface SlackChannel {
  readonly id: string
  readonly name: string
  readonly private: boolean
  readonly bot: boolean
}

// Night Shift: while you are away, mevo reads what comes in and drafts what its bot would say.
// outside: not about your work in the project · ignored: fishing for secrets, the computer or the
// bot's rules (never sent to the model). Neither is ever answered.
export type NightKind = 'info' | 'fact' | 'decision' | 'action' | 'outside' | 'ignored' | 'urgent'

export interface NightReply {
  readonly at: string
  // info: nothing to answer · fact: answerable from your tickets and PRs · decision: needs you ·
  // urgent: wakes you on Telegram
  readonly kind: NightKind
  readonly why: string
  // what the bot would post in the thread (labelled as your assistant); none for info
  readonly draft: string | null
  // posted as the bot: by itself (facts mode) or by you from the handoff
  readonly posted?: { readonly at: string; readonly ts: string; readonly by: 'mevo' | 'you' }
  readonly error?: string
}

export interface NightShiftConfig {
  readonly enabled: boolean
  // shadow: drafts only · facts: also posts the answers that come from your own data
  readonly mode: 'shadow' | 'facts'
  // "HH:MM" this computer's time; from > to crosses midnight
  readonly from: string
  readonly to: string
  readonly days: 'weekdays' | 'daily'
  // your Slack status turns it on: away, or a 🌙 / "night shift" / "ooo" status
  readonly followSlack: boolean
  // names or words that wake you on Telegram ("dom", "prod", "urgent")
  readonly wake: readonly string[]
  // a DM gets its answer in that same DM, from your account, labelled as mevo writing for you
  readonly dmAsMe: boolean
}

export interface Handoff {
  readonly from: string
  readonly to: string
  // the Slack mentions and DMs that came in (their ids in slackMentions)
  readonly messages: readonly string[]
  // what happened on your tickets and PRs while you were away
  readonly events: readonly { readonly id: string; readonly title: string; readonly at: string; readonly what: string; readonly url?: string }[]
  readonly nudges: number
  readonly seen?: boolean
}

export interface NightShiftState {
  readonly active: boolean
  readonly since: string | null
  readonly reason: 'schedule' | 'manual' | 'slack' | null
  // your switch from the app or Telegram; wins over the schedule until the next change of window
  readonly manual: 'on' | 'off' | null
  readonly handoff: Handoff | null
  // the DMs read so far, by conversation
  readonly dmSeen?: Readonly<Record<string, string>>
}

// The engineering principles pack (pstack) the lanes read, pinned to one commit.
export interface PrinciplesStatus {
  readonly enabled: boolean
  readonly repo: string
  readonly ref: string
  // the commit checked out on disk, null before the first fetch
  readonly head: string | null
  readonly error: string | null
  readonly syncedAt: string | null
  // what each list and playbook reads, relative to skills/; missing = not in this commit
  readonly files: Readonly<Record<string, readonly { readonly path: string; readonly present: boolean }[]>>
}
export interface PrinciplesUpdate {
  readonly current: string
  readonly latest: string
  // git diff --stat over skills/, then the diff of the files mevo uses (truncated)
  readonly stat: string
  readonly diff: string
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
  readonly slackMentions?: readonly SlackMention[]
  readonly nightShift?: NightShiftState
  readonly mascot?: MascotStatus
}

// Mo, the mascot: his coffee level and whether he and the coffee game are on
export interface MascotStatus {
  readonly energy: number
  readonly enabled: boolean
  readonly coffee: boolean
}

export type ServerEvent =
  | { readonly type: 'triage'; readonly triage: Readonly<Record<string, Triage>> }
  | { readonly type: 'labels'; readonly labelColors: Readonly<Record<string, string>> }
  | { readonly type: 'slack'; readonly mentions: readonly SlackMention[] }
  | { readonly type: 'night'; readonly night: NightShiftState }
  | { readonly type: 'mascot'; readonly mascot: MascotStatus }
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

// Code the daemon has not loaded yet: changed on disk after it started.
export interface CodeState {
  readonly bootedAt: string
  readonly stale: boolean
  readonly since: string | null
  // a few of the changed files, and how many in all
  readonly files: readonly string[]
  readonly changed: number
  // the app's build stamp (apps/web/dist): a window opened before it changed shows the old app
  readonly web: string | null
  // run by the desktop app, which starts it again after a restart for new code
  readonly supervised: boolean
}

export interface Health {
  readonly startedAt: string
  readonly code?: CodeState
  readonly pid: number
  readonly version: string
  readonly daemon: CheckState
  readonly telegram: CheckState & { readonly bot: string | null }
  readonly linear: CheckState & { readonly lastPollAt: string | null; readonly tracked: number }
  readonly github: CheckState & { readonly login?: string | null }
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
    readonly principles?: PrinciplesStatus
  }
  readonly prSync: CheckState
  // fetching the base branch and counting how far open branches are behind
  readonly mainSync?: CheckState
  // finding PRs you were asked to review
  readonly reviews?: CheckState
  // the signed-in GitHub browser profile mevo uses to attach screenshots and videos
  readonly uploads?: CheckState & { readonly login: string | null }
  readonly figma?: CheckState & { readonly user: string | null }
  readonly slack?: CheckState & { readonly team: string | null; readonly bot: boolean; readonly user: boolean }
  // Android phones for hand tests; adb is null when it is not installed
  readonly android?: CheckState & { readonly adb: string | null; readonly devices: readonly AndroidDevice[] }
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
export * from './timeline.js'
export * from './conversation.js'
export * from './nudge.js'
export * from './linear-sync.js'
export * from './h264.js'

// One PR in "Update all from main": GitHub merges the base into the branch, nothing runs locally.
export interface BranchUpdateResult {
  readonly id: string
  readonly outcome: 'updated' | 'current' | 'conflicts' | 'skipped' | 'failed'
  readonly detail: string
}

// A pull request as GitHub shows it at the top: people, size, checks, reviews.
export interface PrMeta {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly isDraft: boolean
  readonly author: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly mergedAt: string | null
  readonly head: string
  readonly base: string
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly commits: number
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  // the latest review of each person, and who is still asked to review
  readonly reviewers: readonly { readonly login: string; readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED' }[]
  // MERGEABLE, CONFLICTING or UNKNOWN
  readonly mergeable: string
  readonly checks: { readonly passed: number; readonly failed: number; readonly pending: number }
  readonly milestone: string | null
}

// Who shipped the most in the period: tickets done in Linear, PRs merged and reviews given on GitHub.
export interface LeaderRow {
  readonly name: string
  readonly login?: string
  readonly avatar?: string | null
  readonly count: number
  // lines changed, for PRs
  readonly extra?: number
  readonly you: boolean
}
export interface Leaderboard {
  readonly period: 'week' | 'month'
  readonly since: string
  readonly tickets: readonly LeaderRow[]
  readonly prs: readonly LeaderRow[]
  readonly reviews: readonly LeaderRow[]
  // tickets in a started state in Linear right now (in progress, in review, QA), per person
  readonly progress: readonly LeaderRow[]
  readonly at: string
  readonly errors: readonly string[]
}
