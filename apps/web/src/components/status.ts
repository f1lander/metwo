import { markdownSection, modelName, openComments, type Ticket, type TicketStatus } from '@ticketflow/shared'

export { modelName }

// A PR you marked ready for review on GitHub, still open.
export const inReview = (t: Ticket) => t.status === 'pr_draft' && t.pr?.isDraft === false && t.pr.state === 'OPEN'

// In review with teammates' comments you have not fixed, answered or set aside yet.
export const waitingOnComments = (t: Ticket) => inReview(t) && openComments(t).length > 0

// An open PR (draft or in review) that can't merge as it is: conflicts with main on GitHub or in the
// local dry run, a merge you started by hand, or GitHub commits that conflict with local ones.
export function hasConflicts(t: Ticket): boolean {
  if (t.pr?.state !== 'OPEN') return false
  return t.pr.mergeable === 'CONFLICTING' || Boolean(t.behindMain?.conflicts) || Boolean(t.manualMerge) || t.behindPr?.why === 'conflicts'
}

export const COLUMNS: readonly { readonly title: string; readonly dot: string; readonly statuses: readonly TicketStatus[]; readonly match?: (t: Ticket) => boolean }[] = [
  { title: 'Assigned', dot: 'border-[1.5px] border-muted', statuses: ['assigned'] },
  { title: 'Working', dot: 'bg-accent-fg', statuses: ['queued', 'running'] },
  { title: 'Needs me', dot: 'bg-warn', statuses: ['needs_input', 'review_ready', 'no_change', 'stopped', 'failed'] },
  { title: 'Conflicts', dot: 'bg-bad', statuses: ['pr_draft'], match: (t) => hasConflicts(t) },
  { title: 'Draft PR', dot: 'bg-ok-dot', statuses: ['pr_draft'], match: (t) => !inReview(t) && !hasConflicts(t) },
  { title: 'In review', dot: 'bg-accent-fg', statuses: ['pr_draft'], match: (t) => inReview(t) && !hasConflicts(t) },
  { title: 'Closed', dot: 'bg-dim', statuses: ['done', 'skipped'] },
]

export const STATUS_LABEL: Record<TicketStatus, string> = {
  assigned: 'Assigned',
  queued: 'Queued',
  running: 'Working',
  needs_input: 'Question',
  review_ready: 'Review ready',
  no_change: 'No change needed',
  pr_draft: 'PR open',
  stopped: 'Stopped',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
}

export function statusTone(status: TicketStatus): 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' {
  if (status === 'running' || status === 'queued') return 'accent'
  if (status === 'needs_input' || status === 'review_ready' || status === 'no_change' || status === 'stopped') return 'warn'
  if (status === 'failed') return 'bad'
  if (status === 'pr_draft' || status === 'done') return 'ok'
  return 'neutral'
}

export function needsMe(t: Ticket): boolean {
  return ['needs_input', 'review_ready', 'no_change', 'stopped', 'failed'].includes(t.status)
}

export const STEPS = ['Assigned', 'Implementing', 'Review pass', 'Gates + supervisor', 'Your review', 'PR', 'Merged'] as const

const PHASE_STEP = { implementing: 1, review: 2, checks: 3, ready: 4, other: 1 } as const

export function currentStep(t: Ticket): number {
  const phase = t.stage ? PHASE_STEP[t.stage.phase] : t.events.at(-1)?.kind === 'review' ? 2 : 1
  switch (t.status) {
    case 'assigned':
    case 'skipped':
      return 0
    case 'queued':
      return 1
    case 'running':
      // a visual check or QA round on an open PR runs without leaving the PR step
      return t.pr && t.stage?.phase !== 'implementing' ? 5 : Math.min(phase, 3)
    case 'needs_input':
    case 'stopped':
    case 'failed':
      return Math.min(phase, 3)
    case 'review_ready':
    case 'no_change':
      return 4
    case 'pr_draft':
      return 5
    case 'done':
      return 6
  }
}

export function sinceStart(t: Ticket): string | null {
  const start = [...t.events].reverse().find((e) => e.kind === 'start' || e.kind === 'answer' || e.kind === 'fix-comments')
  if (!start) return null
  const m = Math.round((Date.now() - new Date(start.at).getTime()) / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function priorityLabel(p: number): string | null {
  return ({ 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' } as Record<number, string>)[p] ?? null
}

// ARM-SUMMARY.md split into its `## ` sections.
export function summarySections(markdown: string | undefined): readonly { readonly title: string; readonly body: string }[] {
  if (!markdown) return []
  return markdown
    .split(/^##\s+/m)
    .slice(1)
    .map((chunk) => {
      const [title = '', ...rest] = chunk.split('\n')
      return { title: title.trim(), body: rest.join('\n').trim() }
    })
    .filter((s) => s.body)
}

export const summarySection = (markdown: string | undefined, name: RegExp) => markdownSection(markdown, name)

// "4 files changed, 84 insertions(+), 21 deletions(-)" -> "4 files · +84 −21"
export function compactStat(diffStat: string | undefined): string {
  const last = diffStat?.split('\n').at(-1) ?? ''
  const files = /(\d+) files? changed/.exec(last)?.[1]
  const plus = /(\d+) insertions?/.exec(last)?.[1] ?? '0'
  const minus = /(\d+) deletions?/.exec(last)?.[1] ?? '0'
  return files ? `${files} file${files === '1' ? '' : 's'} · +${plus} −${minus}` : last.trim()
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// Rough position in the pipeline for the progress bar; stage-based, not a time estimate.
export function stageProgress(t: Ticket): number {
  switch (t.status) {
    case 'assigned':
    case 'skipped':
      return 0
    case 'queued':
      return 0.08
    case 'running':
      return t.events.at(-1)?.kind === 'review' ? 0.78 : 0.45
    case 'needs_input':
    case 'stopped':
    case 'failed':
      return 0.45
    case 'review_ready':
    case 'no_change':
      return 0.85
    case 'pr_draft':
      return 0.93
    case 'done':
      return 1
  }
}

// matches pipeline.stuckMinutes' default; Health carries the configured value
export const STUCK_MINUTES = 15

// Quiet minutes for a running lane, from the time of its last live line.
export function quietMinutes(t: Ticket, last: { at: string } | undefined): number | null {
  if (t.status !== 'running' || !last) return null
  return Math.floor((Date.now() - new Date(last.at).getTime()) / 60000)
}

// The PR as GitHub shows it: draft, ready for review, merged or closed.
export function prState(t: Ticket): string | null {
  if (!t.pr) return null
  if (t.pr.state === 'MERGED') return 'merged'
  if (t.pr.state === 'CLOSED') return 'closed'
  return t.pr.isDraft ? 'draft' : 'ready for review'
}

// A draft PR Greptile has cleared (or that you want reviewed anyway) can go to teammates.
export function canMarkReady(t: Ticket): boolean {
  return t.status === 'pr_draft' && t.pr?.isDraft === true
}

export function greptileClear(t: Ticket): boolean {
  return t.pr?.greptile?.findings.length === 0
}

// QA / Done write to Linear; offered once there is something to hand over and Linear
// does not already show it there.
export function canMoveInLinear(t: Ticket): boolean {
  const closedInLinear = /^(qa|done|canceled|cancelled)$/i.test(t.linearState)
  return !closedInLinear && ['review_ready', 'no_change', 'pr_draft', 'done'].includes(t.status)
}



// "lite · Opus 5.5 · high": the model claude reported, or the configured one before a run
export function laneLabel(t: Ticket, models?: Readonly<Record<string, { model: string; effort: string }>>): string {
  const lane = t.lane ?? t.suggestedLane
  const spec = models?.[lane]
  const model = t.model ?? spec?.model
  const effort = t.model ? t.effort : t.maxEffort ? 'max' : spec?.effort
  return [lane, modelName(model), effort].filter(Boolean).join(' · ')
}

// While a push runs: the step it is on; after a failure: why.
export function pushLine(t: Ticket): { text: string; bad: boolean } | null {
  if (!t.pushing) return null
  return t.pushing.error ? { text: t.pushing.error, bad: true } : { text: `${t.pushing.step}…`, bad: false }
}

// The latest thing that happened on the ticket (an event or a journal entry), for "updated 10m ago".
export function lastChange(t: Ticket): { readonly at: string; readonly what: string } {
  const ev = t.events.at(-1)
  const j = t.journal?.at(-1)
  const pick = ev && (!j || ev.at >= j.at) ? { at: ev.at, what: ev.message || ev.kind } : j ? { at: j.at, what: j.title } : null
  return pick ?? { at: t.updatedAt || t.seenAt, what: 'seen in Linear' }
}
