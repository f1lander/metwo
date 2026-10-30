import { markdownSection, type Ticket } from '@ticketflow/shared'
import type { CommentMoment, Config } from './config.js'
import type { Linear } from './linear.js'
import { log } from './log.js'
import type { Store } from './store.js'

// Every write metwo makes to Linear goes through here, so each one is signed, journaled and
// switchable from config (linear.comments.enabled / linear.comments.on).
export class LinearWriter {
  constructor(
    private readonly cfg: Config,
    private readonly linear: Linear,
    private readonly store: Store,
  ) {}

  async comment(moment: CommentMoment, ticket: Ticket): Promise<void> {
    const c = this.cfg.linear.comments
    if (!c.enabled || !c.on.includes(moment)) return
    const body = this.compose(moment, ticket)
    if (!body) return
    try {
      const url = await this.linear.comment(ticket.uuid, body)
      this.store.journal(ticket.id, { kind: 'comment', title: `Commented on Linear (${MOMENT_LABEL[moment]})`, body, meta: url ? { url } : {} })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`${ticket.id}: linear comment failed`, message)
      this.store.journal(ticket.id, { kind: 'failure', title: 'Could not comment on Linear', body: message })
    }
  }

  // Moves the issue in Linear and closes it on the board. QA also posts the hand-off comment.
  async move(id: string, to: 'qa' | 'done'): Promise<Ticket> {
    const ticket = this.store.get(id)
    if (!ticket) throw new Error(`unknown ticket ${id}`)
    const stateName = this.cfg.linear.states[to]
    await this.linear.moveToState(ticket.uuid, stateName)
    const moved = this.store.patch(id, { status: 'done', linearState: stateName }, { kind: 'linear', message: `moved to ${stateName} in Linear` })
    this.store.journal(id, { kind: 'linear', title: `Moved to ${stateName} in Linear`, meta: { from: ticket.linearState } })
    await this.comment(to, moved)
    return this.store.get(id) ?? moved
  }

  private compose(moment: CommentMoment, t: Ticket): string | null {
    const what = markdownSection(t.summary, /what changed/i)
    const manual = markdownSection(t.summary, /needs manual test/i)
    const risks = markdownSection(t.summary, /known risks/i)
    const visual = markdownSection(t.summary, /visual check/i)
    const prLine = t.prUrl ? `**PR:** ${t.prUrl}` : ''
    const commits = t.commits ? t.commits.split('\n').filter(Boolean).length : 0

    const parts: readonly (string | false)[] = (() => {
      switch (moment) {
        case 'review_ready':
          return [`**Implementation ready locally** (${commits} commit${commits === 1 ? '' : 's'}, not pushed yet). Being reviewed before a PR opens.`, clip(what)]
        case 'no_change':
          return ['**No code change needed.**', clip(firstParagraph(t.summary) ?? what), visual && `**What was checked:** ${clip(visual, 500)}`]
        case 'pr_opened':
          return [`**Draft PR opened:** ${t.prUrl ?? ''}`, clip(what), manual && `**Needs manual test:** ${clip(manual, 400)}`]
        case 'qa':
          return [
            '**Ready for QA.**',
            prLine,
            clip(what),
            manual && `**How to test:** ${clip(manual, 500)}`,
            risks && !/^none/i.test(risks) && `**Known risks:** ${clip(risks, 400)}`,
          ]
        case 'done':
          return ['**Closed.**', prLine, clip(what || firstParagraph(t.summary) || '', 400)]
        case 'failed':
          return [`**Agent run stopped:** ${t.failure?.title ?? 'failed'}. A person is looking at it.`]
      }
    })()

    const content = parts.filter(Boolean).join('\n\n').trim()
    if (!content) return null
    const header = `> 🤖 **metwo agent**${t.lane ? ` · ${t.lane} lane` : ''}`
    return `${header}\n\n${content}\n\n---\n_${this.cfg.linear.comments.signature}_`
  }
}

const MOMENT_LABEL: Record<CommentMoment, string> = {
  review_ready: 'ready for review',
  no_change: 'no change needed',
  pr_opened: 'PR opened',
  qa: 'moved to QA',
  done: 'closed',
  failed: 'run stopped',
}


function firstParagraph(markdown: string | undefined): string | null {
  const text = markdown?.replace(/^#.*$/gm, '').trim()
  return text ? (text.split(/\n\s*\n/)[0] ?? null) : null
}

function clip(text: string, max = 900): string {
  const clean = text.replace(/\n{3,}/g, '\n\n').trim()
  return clean.length > max ? `${clean.slice(0, max).replace(/\s+\S*$/, '')}…` : clean
}
