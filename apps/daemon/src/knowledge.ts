import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type Config, knowledgeDir } from './config.js'

const run = promisify(execFile)

interface Source {
  readonly name: string
  readonly dir: string
  readonly remote: string | null
  readonly branch: string | null
  readonly index: string | null
  readonly alwaysRead: readonly string[]
  readonly byKeyword: Readonly<Record<string, readonly string[]>>
  readonly review: readonly string[]
  readonly note: string
}

const home = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

// The ENS wiki's review skills, used as lenses when the wiki has them.
const WIKI_LENSES = ['skills/review-common.md', 'skills/ens-code-review/spec.md', 'skills/style-review/spec.md']

// `wiki` plus every `knowledge.sources` entry, each with the folder the lane reads.
export function sources(cfg: Config): readonly Source[] {
  const out: Source[] = []
  if (cfg.wiki.path) {
    const dir = home(cfg.wiki.path)
    out.push({ name: 'wiki', dir, remote: null, branch: null, index: 'INDEX.md', alwaysRead: cfg.wiki.alwaysRead, byKeyword: cfg.wiki.byKeyword, review: WIKI_LENSES.filter((p) => existsSync(path.join(dir, p))), note: 'the team wiki' })
  }
  for (const s of cfg.knowledge.sources) {
    const dir = s.path ? home(s.path) : path.join(knowledgeDir(), slug(s.name))
    out.push({ name: s.name, dir, remote: s.git ?? null, branch: s.branch ?? null, index: s.index ?? null, alwaysRead: s.alwaysRead ?? [], byKeyword: s.byKeyword ?? {}, review: s.review ?? [], note: s.note ?? '' })
  }
  return out.filter((s) => existsSync(s.dir))
}

function pagesFor(s: Source, text: string): readonly string[] {
  const lower = text.toLowerCase()
  const picked = new Set(s.alwaysRead)
  for (const [keyword, pages] of Object.entries(s.byKeyword)) if (lower.includes(keyword.toLowerCase())) for (const p of pages) picked.add(p)
  return [...picked]
}

// The brief section: what to read first in each source, and the pages this ticket needs.
export function knowledgeSection(cfg: Config, text: string): string {
  const list = sources(cfg)
  if (list.length === 0) return ''
  const blocks = list.map((s) => {
    const pages = pagesFor(s, text)
    const index = s.index && existsSync(path.join(s.dir, s.index)) ? path.join(s.dir, s.index) : null
    return [
      `### ${s.name}${s.note ? ` (${s.note})` : ''}: ${s.dir}`,
      index ? `- ALWAYS FIRST: read ${index} in full. It is the map of what this source knows; do this before you read the ticket's code, every run.` : '- Skim the folder layout and its README first.',
      pages.length ? `- Then read these pages, plus anything the index points to for this ticket. Grep the folder when you need more:\n${pages.map((p) => `  - ${path.join(s.dir, p)}`).join('\n')}` : '- Grep it for the areas this ticket touches.',
    ].join('\n')
  })
  return `## Team knowledge (read first, read-only)\n${blocks.join('\n\n')}`
}

// One line per source, for prompts that only need a pointer.
export function knowledgePointers(cfg: Config): string {
  return sources(cfg)
    .map((s) => `- ${s.name}: ${s.dir}${s.index ? ` (start from ${s.index})` : ''}`)
    .join('\n')
}

export function reviewLenses(cfg: Config): readonly string[] {
  return sources(cfg).flatMap((s) => s.review.map((p) => path.join(s.dir, p)))
}

const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', 'STYLEGUIDE.md', 'REVIEW.md', 'CONTRIBUTING.md', '.greptile/config.json', '.greptile/rules.md', '.cursorrules', '.github/copilot-instructions.md']

// The repo's own instructions for agents and reviewers that exist at its root.
export function repoRules(repo: string): readonly string[] {
  return RULE_FILES.filter((f) => existsSync(path.join(repo, f)))
}

// Clones the git sources that are missing and fast-forwards the rest. Failures are reported, not thrown.
export async function syncKnowledge(cfg: Config): Promise<readonly string[]> {
  const problems: string[] = []
  for (const s of cfg.knowledge.sources) {
    if (!s.git || s.path) continue
    const dir = path.join(knowledgeDir(), slug(s.name))
    try {
      if (!existsSync(path.join(dir, '.git'))) {
        mkdirSync(path.dirname(dir), { recursive: true })
        await run('git', ['clone', '--depth', '1', ...(s.branch ? ['--branch', s.branch] : []), s.git, dir], { timeout: 180_000 })
      } else {
        await run('git', ['pull', '--ff-only', '--depth', '1'], { cwd: dir, timeout: 120_000 })
      }
    } catch (error) {
      problems.push(`${s.name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return problems
}
