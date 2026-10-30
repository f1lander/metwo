import { markdownSection, type Ticket } from '@ticketflow/shared'
import { log } from '../log.js'

export const STATUS_ICON: Record<Ticket['status'], string> = {
  assigned: '🆕',
  queued: '⏳',
  running: '🔧',
  needs_input: '❓',
  review_ready: '👀',
  pr_draft: '🔀',
  stopped: '⏹',
  done: '✅',
  skipped: '⏭',
  failed: '💥',
  no_change: '🟰',
}

export const COMMANDS = [
  { command: 'status', description: 'what is in flight right now' },
  { command: 'list', description: 'tickets waiting for a decision (with buttons)' },
  { command: 'tickets', description: 'every tracked ticket by status' },
  { command: 'progress', description: '/progress WEB-123 · log and last activity' },
  { command: 'start', description: '/start WEB-123 lite|full|max [engine]' },
  { command: 'push', description: '/push WEB-123 · push + draft PR' },
  { command: 'skip', description: '/skip WEB-123' },
  { command: 'stop', description: '/stop WEB-123 · kill its lane, keep a note to resume (asks first)' },
  { command: 'stopall', description: 'stop every lane, optionally shut the daemon down (asks first)' },
  { command: 'update', description: '/update WEB-123 · merge main into the branch, push if green' },
  { command: 'review', description: '/review <PR link or number> · review a PR someone asked you about' },
  { command: 'reviews', description: 'PRs waiting for your review' },
  { command: 'cycle', description: 'unassigned issues in the current cycle, to take on' },
  { command: 'tell', description: '/tell WEB-654 what to change · or just write it, screenshots welcome' },
  { command: 'learn', description: 'propose team rules from recent PR feedback' },
  { command: 'learnings', description: 'rules waiting for your approval' },
  { command: 'visual', description: '/visual WEB-123 · run the visual check again (no code changes)' },
  { command: 'desc', description: '/desc WEB-123 · tick the PR description checklists from the latest work (you approve)' },
  { command: 'greptile', description: '/greptile WEB-123 · ask Greptile for a new review' },
  { command: 'ready', description: '/ready WEB-123 · take the PR out of draft for review' },
  { command: 'ghlogin', description: 'sign metwo’s browser into GitHub (opens on the Mac)' },
  { command: 'preview', description: '/preview WEB-123 · QA round on the PR preview deploy (you post it)' },
  { command: 'qa', description: '/qa WEB-123 · move to QA in Linear (posts the hand-off)' },
  { command: 'done', description: '/done WEB-123 · move to Done in Linear' },
  { command: 'dismiss', description: '/dismiss WEB-123 · close it in metwo only' },
  { command: 'note', description: '/note WEB-123 text · add to the ticket journal' },
  { command: 'digest', description: 'today in one message: closed, waiting, PRs, cost' },
  { command: 'health', description: 'daemon, bot, linear, github, claude, e2e' },
  { command: 'effort', description: '/effort medium · low, medium or high for every lane' },
  { command: 'lanes', description: '/lanes 4 · how many tickets run at once' },
  { command: 'autopilot', description: '/autopilot on|off · small tickets start (and get their draft PR) on their own' },
  { command: 'budget', description: '/budget · spend vs limits · /budget day 20 · /budget month 300' },
  { command: 'pause', description: 'stop starting new lanes' },
  { command: 'resume', description: '/resume WEB-123 picks a stopped ticket up · /resume alone starts lanes again' },
  { command: 'tunnel', description: 'dashboard link for the phone' },
  { command: 'help', description: 'commands' },
]

export const section400 = (markdown: string | undefined, heading: string) => markdownSection(markdown, heading).slice(0, 400)

export function ticketIn(text: string): string | null {
  const m = /\b([A-Z]{2,10})-(\d+)\b/i.exec(text)
  return m ? `${m[1]?.toUpperCase()}-${m[2]}` : null
}

export function normalizeId(raw: string): string {
  const m = /([a-z]+)-?(\d+)/i.exec(raw.trim())
  return m ? `${m[1]?.toUpperCase()}-${m[2]}` : ''
}

export function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`)
}

export const VISUAL_LABEL = { verified: '✅ verified', partial: '🟡 partly verified', not_verified: '🔴 not verified', not_applicable: 'nothing visual' } as const

export const SUPERVISION_LABEL = { pass: '✅ pass', concerns: '🟡 concerns', fail: '🔴 fail' } as const
