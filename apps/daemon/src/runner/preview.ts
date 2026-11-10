import { CONTEXT_INFO, type ContextBlock, type Effort, type PromptPreview, STEP_CONTEXT, type StepId, type Ticket } from '@ticketflow/shared'
import { type Config, ctxOn, effective } from '../config.js'
import { figmaLinks } from '../figma.js'
import type { LinearComment } from '../linear.js'
import { playbookFor, principlesSection } from '../principles.js'
import { briefBlocks, reviewPrompt, stepInstructions } from './brief.js'
import { contextSection, imageUrls } from './context.js'
import { quickPrompt, visualCheckPrompt } from './prompts.js'
import { securityHits, securityLens } from './quality.js'
import { git } from './shell.js'
import { supervisorPrompt } from './supervise.js'

export interface PreviewDeps {
  readonly cfg: Config
  readonly ticket: Ticket
  readonly step: StepId
  readonly flowDir: string
  readonly engine: string
  readonly effort: Effort
  readonly comments: () => Promise<readonly LinearComment[]>
  readonly learnings: string
  readonly feedback: (q: { files?: readonly string[]; text?: string; excludePr?: number }) => string
  readonly triage: Parameters<typeof playbookFor>[1]
}

const SLACK_LINK = /https:\/\/[\w-]+\.slack\.com\/archives\/\S+/g
const off = (cfg: Config, step: StepId, b: ContextBlock) => effective(cfg, { steps: { [step]: { context: { [b]: false } } } })

// The prompt a step would get for this ticket, in blocks with their size. Nothing runs and nothing
// is written; Figma and Slack are fetched only when the lane starts, so they show as notes.
export async function buildPreview(d: PreviewDeps): Promise<PromptPreview> {
  const { cfg, ticket, step, flowDir } = d
  const notes: string[] = []
  const wt = ticket.worktree ?? cfg.repo.path
  const port = ticket.port ?? cfg.pipeline.portBase
  const out = (text: string, blocks: PromptPreview['blocks']): PromptPreview => ({ step, ticket: ticket.id, engine: d.engine, effort: d.effort, blocks, text, notes })
  if (!ticket.worktree && step !== 'implement') notes.push('No worktree yet: paths point at the main checkout and the diff is empty.')

  if (step === 'implement') {
    const on = (b: ContextBlock) => ctxOn(cfg, 'implement', b)
    const comments = on('linear') ? await d.comments().catch(() => []) : []
    const images = on('linear') ? imageUrls(ticket.description, ...comments.map((c) => c.body)) : []
    const linear = contextSection({ comments, images: images.map((from, i) => ({ file: `${flowDir}/images/${String(i + 1).padStart(2, '0')}.png`, from })) })
    const texts = [ticket.description, ...comments.map((c) => c.body)]
    const slack = texts.join('\n').match(SLACK_LINK)?.length ?? 0
    const figma = figmaLinks(...texts).length
    if (images.length) notes.push(`${images.length} image(s) from Linear are downloaded when the lane starts.`)
    if (on('slack') && slack && cfg.slack.threads) notes.push(`${slack} Slack thread(s) linked in the ticket are read when the lane starts.`)
    if (on('figma') && figma && cfg.figma.enabled) notes.push(`${figma} Figma frame(s) are fetched when the lane starts and added as the design reference.`)
    const feedback = on('feedback') ? d.feedback({ text: `${ticket.title}\n${ticket.description}\n${ticket.labels.join(' ')}`, ...(ticket.pr ? { excludePr: ticket.pr.number } : {}) }) : ''
    const principles = on('principles') ? principlesSection(cfg, ticket, playbookFor(ticket, d.triage)).text : ''
    if (on('principles') && !principles && (ticket.principles ?? cfg.principles.enabled)) notes.push('Engineering principles are on but the pinned pstack commit is not on disk yet; it is fetched when the lane starts.')
    const blocks = briefBlocks(cfg, ticket, wt, flowDir, port, [linear, feedback].filter(Boolean).join('\n\n'), d.learnings, principles)
    const rows = blocks.flatMap((b): PromptPreview['blocks'][number][] =>
      b.id === 'context'
        ? [
            { id: 'linear', title: CONTEXT_INFO.linear.label, chars: linear ? b.text.length - feedback.length : 0, context: 'linear', on: on('linear') },
            { id: 'slack', title: CONTEXT_INFO.slack.label, chars: 0, context: 'slack', on: on('slack') },
            { id: 'figma', title: CONTEXT_INFO.figma.label, chars: 0, context: 'figma', on: on('figma') },
            { id: 'feedback', title: CONTEXT_INFO.feedback.label, chars: linear ? feedback.length : b.text.length, context: 'feedback', on: on('feedback') },
          ]
        : [{ id: b.id, title: b.title, chars: b.text.length, ...(b.context ? { context: b.context, on: on(b.context) } : { on: b.on }) }],
    )
    return out(blocks.map((b) => b.text).join(''), rows)
  }

  let diff = ''
  let files: string[] = []
  if (ticket.worktree) {
    diff = await git(['diff', '--no-color', `origin/${cfg.repo.baseBranch}...HEAD`], wt).catch(() => '')
    files = (await git(['diff', '--name-only', `origin/${cfg.repo.baseBranch}...HEAD`], wt).catch(() => '')).split('\n').filter(Boolean)
  }
  const build = (c: Config): string => {
    if (step === 'review') {
      const hits = c.quality.securityLens ? securityHits(diff, c.quality.security) : []
      return reviewPrompt(c, ticket, wt, d.feedback({ files, text: ticket.title, ...(ticket.pr ? { excludePr: ticket.pr.number } : {}) }), hits.length ? securityLens(hits) : '')
    }
    if (step === 'supervisor') {
      const gates = (['typecheck', 'lint', 'test'] as const).filter((g) => c.repo.commands[g]).map((name) => ({ name, ok: true, tail: '' }))
      return supervisorPrompt(c, ticket, wt, flowDir, gates)
    }
    if (step === 'visual') return visualCheckPrompt(c, ticket, flowDir, port)
    return quickPrompt(ticket.id, '<what it is for: the review comments, Greptile findings or the change you ask for>', '<the items you pick>', flowDir, c.repo.baseBranch, stepInstructions(c, 'quick'))
  }
  if (step === 'supervisor') notes.push('mevo re-runs the gates first; this prompt is sent only when they pass.')
  if (step === 'quick') notes.push('The items are filled in when you start a quick fix.')
  if (step === 'review' && cfg.quality.securityLens && !securityHits(diff, cfg.quality.security).length) notes.push('The security lens is added when the diff touches signing, transactions, auth, storage or HTML.')
  const text = build(cfg)
  const instr = stepInstructions(cfg, step).length
  const ctx = STEP_CONTEXT[step].map((b) => ({ id: b, title: CONTEXT_INFO[b].label, chars: ctxOn(cfg, step, b) ? text.length - build(off(cfg, step, b)).length : 0, context: b, on: ctxOn(cfg, step, b) }))
  const rest = text.length - instr - ctx.reduce((n, b) => n + b.chars, 0)
  return out(text, [{ id: 'prompt', title: 'Prompt', chars: rest, on: true }, ...ctx, { id: 'instructions', title: 'Team instructions', chars: instr, on: instr > 0 }])
}
