import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LearningProposal, Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { Engine } from './engines/index.js'
import { knowledgePointers, repoRules } from './knowledge.js'

// Team learnings: a curator engine reads the feedback our PRs got (Greptile, teammates, the
// supervisor, your own instructions, failures) and proposes short rules. Nothing reaches a brief
// until you approve it; approved rules live in learnings/rules.md in this repo, versioned.
export class Learnings {
  private readonly dir: string
  private readonly rulesFile: string
  private readonly stateFile: string

  constructor(
    rootDir: string,
    dataDir: string,
    private readonly cfg: Config,
  ) {
    this.dir = path.join(rootDir, 'learnings')
    this.rulesFile = path.join(this.dir, 'rules.md')
    this.stateFile = path.join(dataDir, 'learnings.json')
  }

  private load(): { lastRunAt: string | null; proposals: LearningProposal[] } {
    if (!existsSync(this.stateFile)) return { lastRunAt: null, proposals: [] }
    return JSON.parse(readFileSync(this.stateFile, 'utf8')) as { lastRunAt: string | null; proposals: LearningProposal[] }
  }

  private save(state: { lastRunAt: string | null; proposals: LearningProposal[] }): void {
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, this.stateFile)
  }

  rules(): string {
    return existsSync(this.rulesFile) ? readFileSync(this.rulesFile, 'utf8') : ''
  }

  view(): { lastRunAt: string | null; proposals: readonly LearningProposal[]; rules: string } {
    const s = this.load()
    return { lastRunAt: s.lastRunAt, proposals: s.proposals.filter((p) => p.status === 'proposed'), rules: this.rules() }
  }

  // Everything people and checks said about our work since the last run, as one markdown file.
  feedback(tickets: readonly Ticket[], since: string): string {
    const out: string[] = []
    for (const t of tickets) {
      const lines: string[] = []
      for (const j of t.journal ?? []) {
        if (j.at <= since) continue
        const keep =
          (j.kind === 'review' && /Greptile|Supervisor/.test(j.title)) ||
          (j.kind === 'note' && j.title.startsWith('You asked')) ||
          j.kind === 'failure' ||
          (j.kind === 'answer' && /comment|Greptile/i.test(j.title))
        if (keep) lines.push(`- ${j.at.slice(0, 10)} ${j.title}${j.body ? `\n  ${j.body.replace(/\n/g, '\n  ').slice(0, 1500)}` : ''}`)
      }
      for (const c of t.pr?.comments ?? []) {
        if (c.bot || c.createdAt <= since || c.body.trim().startsWith(this.cfg.github.greptile.trigger)) continue
        lines.push(`- teammate ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.replace(/\s+/g, ' ').slice(0, 600)}`)
      }
      if (lines.length) out.push(`## ${t.id} · ${t.title}${t.prUrl ? ` (${t.prUrl})` : ''}\n${lines.join('\n')}`)
    }
    return out.join('\n\n')
  }

  async run(engine: Engine, model: string, tickets: readonly Ticket[], logDir: string): Promise<number> {
    const state = this.load()
    const since = state.lastRunAt ?? '1970-01-01'
    const feedback = this.feedback(tickets, since)
    const startedAt = new Date().toISOString()
    if (!feedback.trim()) {
      this.save({ ...state, lastRunAt: startedAt })
      return 0
    }
    const work = path.join(this.dir, '.work')
    mkdirSync(work, { recursive: true })
    writeFileSync(path.join(work, 'feedback.md'), feedback)
    writeFileSync(path.join(work, 'rules.md'), this.rules())
    const out = path.join(work, 'proposals.json')
    const prompt = `You curate the team learnings for an automated coding pipeline on ${this.cfg.repo.path}.
Read ${path.join(work, 'feedback.md')}: what reviewers, Greptile, a supervisor model and the developer said about recent PRs.
Read ${path.join(work, 'rules.md')}: the rules already approved. Also skim the team knowledge${knowledgePointers(this.cfg) ? ` (${knowledgePointers(this.cfg).replace(/\n/g, ' ')})` : ''} and the repo rules (${repoRules(this.cfg.repo.path).join(', ') || 'none'} in ${this.cfg.repo.path}): they win over any learning.

Propose at most 5 NEW rules that would have prevented a repeated or costly piece of feedback. A good rule is one or two sentences, concrete (names the component, file pattern or check), and applies to future tickets, not just this one. Skip one-off fixes, anything already in rules.md, the team knowledge or the repo rules, and anything that contradicts them.

Write ${out} as JSON and nothing else:
[{ "rule": "...", "area": "the app or package it applies to, or process", "why": "the feedback it comes from, one line", "sources": ["PR or ticket links"] }]
Write [] if nothing qualifies. Do not edit any other file.`
    const result = await engine.run({ cwd: work, prompt, model, effort: 'medium', logFile: path.join(logDir, 'curator.jsonl') })
    let raw: unknown = []
    try {
      raw = JSON.parse(readFileSync(out, 'utf8'))
    } catch {
      raw = []
    }
    const fresh: LearningProposal[] = (Array.isArray(raw) ? raw : [])
      .filter((p): p is { rule: string; area?: string; why?: string; sources?: unknown } => Boolean(p) && typeof (p as { rule?: unknown }).rule === 'string')
      .slice(0, 5)
      .map((p, i) => ({
        id: `${startedAt.slice(0, 10)}-${Date.now().toString(36)}-${i}`,
        rule: p.rule.trim(),
        area: typeof p.area === 'string' ? p.area : 'process',
        why: typeof p.why === 'string' ? p.why : '',
        sources: Array.isArray(p.sources) ? p.sources.filter((s): s is string => typeof s === 'string').slice(0, 5) : [],
        status: 'proposed',
        at: startedAt,
        engine: result.model ?? engine.id,
      }))
    this.save({ lastRunAt: startedAt, proposals: [...state.proposals, ...fresh] })
    return fresh.length
  }

  // Approve (optionally with your own wording) or reject a proposal.
  decide(id: string, approve: boolean, text?: string): LearningProposal | null {
    const state = this.load()
    const p = state.proposals.find((x) => x.id === id)
    if (!p || p.status !== 'proposed') return null
    const decided: LearningProposal = { ...p, rule: text?.trim() || p.rule, status: approve ? 'approved' : 'rejected' }
    if (approve) this.appendRule(decided)
    this.save({ ...state, proposals: state.proposals.map((x) => (x.id === id ? decided : x)) })
    return decided
  }

  private appendRule(p: LearningProposal): void {
    mkdirSync(this.dir, { recursive: true })
    let rules = this.rules() || '# Team learnings\n\nApproved in metwo from PR feedback. Every brief includes this file; the team wiki and the repo rules still win.\n'
    const heading = `## ${p.area}`
    const line = `- ${p.rule}${p.sources.length ? ` (${p.sources.join(', ')})` : ''}`
    rules = rules.includes(`\n${heading}\n`) ? rules.replace(`\n${heading}\n`, `\n${heading}\n${line}\n`) : `${rules.trimEnd()}\n\n${heading}\n${line}\n`
    writeFileSync(this.rulesFile, rules)
  }

  // Removes one approved rule by its exact text (from the Learnings page).
  removeRule(rule: string): boolean {
    const rules = this.rules()
    const lines = rules.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('- ') && l.slice(2).startsWith(rule))
    if (idx === -1) return false
    lines.splice(idx, 1)
    writeFileSync(this.rulesFile, lines.join('\n'))
    return true
  }
}
