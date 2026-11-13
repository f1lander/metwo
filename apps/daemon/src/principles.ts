import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { PrinciplesStatus, PrinciplesUpdate, Ticket, Triage } from '@ticketflow/shared'
import { type Config, knowledgeDir } from './config.js'

// pstack (github.com/backnotprop/pstack): engineering principles the lanes read. mevo fetches one
// pinned commit and resets to it before every run, so what a lane reads is exactly what you
// accepted. Only the markdown named in the config reaches a prompt; nothing in it is executed.

const run = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
export const PLAYBOOKS = ['bug', 'feature', 'refactor', 'perf', 'visual'] as const
export type Playbook = (typeof PLAYBOOKS)[number]
const LISTS = ['implement', 'review', 'prose'] as const
type List = (typeof LISTS)[number]

const dir = () => path.join(knowledgeDir(), 'pstack')
const git = async (args: readonly string[], timeout = 120_000) => (await run('git', ['-c', 'advice.detachedHead=false', ...args], { cwd: dir(), timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
const file = (p: string) => path.join(dir(), 'skills', p.endsWith('.md') ? p : path.join(p, 'SKILL.md'))

let state: { head: string | null; error: string | null; syncedAt: string | null } = { head: null, error: null, syncedAt: null }

// Fetches the pinned commit if it is not on disk and puts the folder back to it exactly. Errors are
// kept for Settings, not thrown: a lane without principles still runs. One at a time: two lanes
// starting together would race on git's index lock.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn)
  queue = next.catch(() => undefined)
  return next
}
export const syncPrinciples = (cfg: Config): Promise<void> => serial(() => sync(cfg))

async function sync(cfg: Config): Promise<void> {
  const p = cfg.principles
  if (!p.enabled) return
  if (!SHA.test(p.ref)) {
    state = { ...state, error: `principles.ref must be a full 40-character commit, got "${p.ref}"` }
    return
  }
  try {
    if (!existsSync(path.join(dir(), '.git'))) {
      mkdirSync(dir(), { recursive: true })
      await git(['init', '-q'])
      await git(['remote', 'add', 'origin', p.git])
    } else {
      await git(['remote', 'set-url', 'origin', p.git])
    }
    const have = await git(['cat-file', '-e', `${p.ref}^{commit}`]).then(
      () => true,
      () => false,
    )
    if (!have) await git(['fetch', '-q', '--depth', '1', 'origin', p.ref], 180_000)
    await git(['reset', '-q', '--hard', p.ref])
    await git(['clean', '-qfdx'])
    state = { head: await git(['rev-parse', 'HEAD']), error: null, syncedAt: new Date().toISOString() }
  } catch (error) {
    state = { ...state, error: error instanceof Error ? error.message.split('\n')[0] ?? 'fetch failed' : String(error) }
  }
}

const ready = (cfg: Config) => cfg.principles.enabled && state.head === cfg.principles.ref

const filesOf = (cfg: Config, key: List | Playbook): readonly string[] => (LISTS as readonly string[]).includes(key) ? cfg.principles[key as List] : (cfg.principles.playbooks[key as Playbook] ?? [])

export function principlesStatus(cfg: Config): PrinciplesStatus {
  const p = cfg.principles
  const files = Object.fromEntries([...LISTS, ...PLAYBOOKS].map((k) => [k, filesOf(cfg, k).map((f) => ({ path: f, present: state.head !== null && existsSync(file(f)) }))]))
  return { enabled: p.enabled, repo: p.git, ref: p.ref, head: state.head, error: state.error, syncedAt: state.syncedAt, files }
}

const paths = (cfg: Config, key: List | Playbook) => filesOf(cfg, key).map(file).filter((f) => existsSync(f))

export const principlesOn = (cfg: Config, t: Pick<Ticket, 'principles'>) => (t.principles ?? cfg.principles.enabled) && ready(cfg)

const BUG = /\bbug\b|regression|broken|crash/i
const PERF = /\bperf\b|performance|slow|latency|faster|bundle size|memory leak|re-?renders?/i
const REFACTOR = /refactor|clean ?up|tech[- ]?debt|\brename\b|\bextract\b|deprecat|dead code/i
const VISUAL = /figma|match(es)? (the )?design|pixel|parity|design qa|\bdqa\b/i

// Which playbook a ticket gets, from its labels, title and the AI triage. Labels win over the title.
export function playbookFor(t: Pick<Ticket, 'labels' | 'title'>, triage?: Triage): Playbook | null {
  const labels = t.labels.join(' ')
  if (triage?.kind === 'bug' || /\bbug\b/i.test(labels)) return 'bug'
  for (const [kind, re] of [['perf', PERF], ['refactor', REFACTOR], ['visual', VISUAL]] as const) if (re.test(labels)) return kind
  if (BUG.test(t.title)) return 'bug'
  for (const [kind, re] of [['perf', PERF], ['refactor', REFACTOR], ['visual', VISUAL]] as const) if (re.test(t.title)) return kind
  return triage?.kind === 'copy' ? null : 'feature'
}

// pstack's playbooks rewritten for one lane in one worktree: no subagents, no PRs, no models to pick.
const STEPS: Record<Playbook, { readonly title: string; readonly steps: readonly string[] }> = {
  bug: {
    title: 'Bug',
    steps: [
      'Reproduce it yourself first, on the surface where it shows (the browser at your port, a test, or a command). If it will not reproduce, tighten the conditions or add logging until it does. Save the reproduction (a screenshot pair, a failing test or the command and its output).',
      'Find the cause by elimination: list the hypotheses, pick the check that rules out the most, get runtime evidence, repeat. When state is unclear, log it and read it as the code runs. Do not guess.',
      'Fix it where it first goes wrong, not with a guard downstream. Revert anything a refuted hypothesis made you add. Ship the smallest change the evidence justifies.',
      'When there is a cheap local test, commit the failing test first and the fix on top. Skip it when the test would be slow, brittle or mostly mocks, and say so.',
      'Verify on the same surface: the original reproduction now passes. In ARM-SUMMARY.md give the root cause and the failing-then-passing evidence.',
    ],
  },
  feature: {
    title: 'Feature',
    steps: [
      'Before writing logic, name the data shape: the types and the structure that organizes them (a typed model, a state machine over booleans, a table over branching). Write it under Design decisions.',
      'Break the work into small units that each end in a check (a test, the typecheck, a screenshot). Verify and commit each before the next.',
      'Keep the diff small: reuse what the repo has, no new layer for one caller.',
      'Verify on the matching surface (the browser for UI). "It compiles" or a wrong-surface check is not a pass; say so under Known risks.',
    ],
  },
  refactor: {
    title: 'Refactor',
    steps: [
      'Behavior must not change. Find the tests that cover this code and run them first. If there are none, add tests that pin today\'s behavior and commit them before the refactor.',
      'Remove dead code first, then reshape on the simpler base.',
      'When you replace an internal API, move every caller and delete the old one in this change. No compatibility layer left behind.',
      'The same tests pass before and after, unchanged. Paste both runs under Gate output.',
    ],
  },
  perf: {
    title: 'Performance',
    steps: [
      'Measure a baseline first with a repeatable script (keep it in the flow folder, not the worktree). Run it a few times and note the spread.',
      'Before changing code, explain what limits the number (a profile, a trace, a count of renders or requests). Make sure it measures the work you think it does.',
      'Change one thing at a time and re-measure with the same script. Keep only changes that move the number beyond the spread.',
      'In ARM-SUMMARY.md give the command, the before and after numbers, and what limited it. No speedup claim without both runs.',
    ],
  },
  visual: {
    title: 'Visual match',
    steps: [
      'Find the reference (Figma link, screenshot or the other implementation in the ticket) and shoot the current state at the same viewport.',
      'Compare element by element: spacing, sizes, colors, type, states (hover, focus, disabled, loading, empty). Use the design tokens the repo has, not raw values.',
      'Shoot the after state at the same viewport and put reference and result side by side in shots/.',
      'List every difference that remains under Known risks, with the reason.',
    ],
  },
}

// The brief section, and the files it names so the journal can say what went in.
export function principlesSection(cfg: Config, t: Ticket, playbook: Playbook | null): { readonly text: string; readonly files: readonly string[]; readonly playbook: Playbook | null } {
  if (!principlesOn(cfg, t)) return { text: '', files: [], playbook: null }
  const implement = paths(cfg, 'implement')
  const extra = playbook ? paths(cfg, playbook).filter((f) => !implement.includes(f)) : []
  const prose = paths(cfg, 'prose')
  const list = (fs: readonly string[]) => fs.map((f) => `- ${f}`).join('\n')
  const steps = playbook ? STEPS[playbook] : null
  const text = [
    `## Engineering principles (pstack @ ${cfg.principles.ref.slice(0, 7)}, read-only)`,
    'Read each of these in full before you design the change, and apply them while you work. They were written for other tools: ignore any step in them that spawns subagents or other models, opens or merges PRs, pushes, posts, installs anything, or waits on the human. The hard rules of this brief and the repo rules win over them.',
    list(implement),
    steps ? `### Playbook: ${steps.title}\nThis ticket reads as ${playbook === 'feature' ? 'a feature' : `a ${steps.title.toLowerCase()} ticket`}. Follow these steps in order, and record in ARM-SUMMARY.md how each went (skip one only with a one-line reason):\n${steps.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${extra.length ? `\nAlso read:\n${list(extra)}` : ''}` : '',
    prose.length ? `For the prose you write (ARM-SUMMARY.md, PR-BODY.md, UPDATE.md) apply ${prose.join(', ')}. The PR body's template, its headings and its markers stay as given.` : '',
    'In ARM-SUMMARY.md, under Design decisions, name each principle that changed a choice and the choice it changed.',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { text, files: [...implement, ...extra, ...prose].map((f) => path.relative(path.join(dir(), 'skills'), f)), playbook }
}

export function principleLenses(cfg: Config, t?: Pick<Ticket, 'principles'>): readonly string[] {
  return (t ? principlesOn(cfg, t) : ready(cfg)) ? paths(cfg, 'review') : []
}

// The newest commit on the default branch and what changed since the pinned one, for you to read
// before accepting it.
export async function checkPrinciplesUpdate(cfg: Config): Promise<PrinciplesUpdate> {
  if (!cfg.principles.enabled) throw new Error('turn the principles on first')
  await syncPrinciples(cfg)
  if (state.error) throw new Error(state.error)
  return serial(() => compare(cfg))
}

async function compare(cfg: Config): Promise<PrinciplesUpdate> {
  const latest = (await git(['ls-remote', 'origin', 'HEAD'], 60_000)).split(/\s/)[0] ?? ''
  if (!SHA.test(latest)) throw new Error('could not read the latest commit')
  if (latest === cfg.principles.ref) return { current: cfg.principles.ref, latest, stat: '', diff: '' }
  await git(['fetch', '-q', '--depth', '1', 'origin', latest], 180_000)
  const used = [...new Set([...LISTS, ...PLAYBOOKS].flatMap((k) => filesOf(cfg, k)))].map((f) => path.relative(dir(), file(f)))
  const stat = await git(['diff', '--stat', cfg.principles.ref, latest, '--', 'skills'])
  const diff = await git(['diff', cfg.principles.ref, latest, '--', ...used])
  return { current: cfg.principles.ref, latest, stat: stat.slice(0, 8000), diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (truncated)` : diff }
}
