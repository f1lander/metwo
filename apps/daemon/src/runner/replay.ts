import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { PassMetrics, Ticket } from '@ticketflow/shared'
import type { Config } from '../config.js'
import { git } from './shell.js'

// What a replay runs with, in one line, saved on it so the comparison says what changed.
export function settingsSummary(cfg: Config): string {
  const engine = (ref: string, model: string) => (ref === 'claude' ? `claude · ${model}` : ref)
  const off = Object.entries(cfg.steps.implement.context)
    .filter(([, on]) => on === false)
    .map(([b]) => b)
  return [
    `screenshots: ${cfg.shots.mode}`,
    `browser check: ${cfg.steps.implement.context.browser === false ? 'off' : 'on'}`,
    `implementer: ${engine(cfg.roles.implementer.lite, cfg.models.lite.model)}${cfg.roles.implementer.full !== cfg.roles.implementer.lite || cfg.models.full.model !== cfg.models.lite.model ? ` / full ${engine(cfg.roles.implementer.full, cfg.models.full.model)}` : ''}`,
    `effort: ${cfg.pipeline.effort}`,
    `review pass: ${cfg.pipeline.reviewPass ? engine(cfg.roles.reviewer, cfg.models.review.model) : 'off'}`,
    `supervisor: ${cfg.roles.supervisor}`,
    ...(off.filter((b) => b !== 'browser').length ? [`context off: ${off.filter((b) => b !== 'browser').join(', ')}`] : []),
  ].join(' · ')
}

// Where the original started: the fork point of its branch from the base branch. When the
// branch is gone (merged and deleted), today's base, and the replay says so.
export async function startPoint(cfg: Config, original: Ticket): Promise<{ base: string; note?: string }> {
  const repo = cfg.repo.path
  await git(['fetch', 'origin', cfg.repo.baseBranch], repo).catch(() => '')
  for (const ref of [original.branch, `origin/${original.branch}`]) {
    const base = await git(['merge-base', `origin/${cfg.repo.baseBranch}`, ref], repo).catch(() => '')
    if (base) return { base }
  }
  return { base: await git(['rev-parse', `origin/${cfg.repo.baseBranch}`], repo), note: `${original.branch} is gone, so it started from today's ${cfg.repo.baseBranch}` }
}

// The files a branch changed since it left the base branch
export async function filesTouched(cfg: Config, branch: string, cwd?: string): Promise<string[] | null> {
  const repo = cfg.repo.path
  for (const ref of cwd ? ['HEAD'] : [branch, `origin/${branch}`]) {
    const base = await git(['merge-base', `origin/${cfg.repo.baseBranch}`, ref], cwd ?? repo).catch(() => '')
    if (!base) continue
    const out = await git(['diff', '--name-only', `${base}..${ref}`], cwd ?? repo).catch(() => null)
    if (out !== null) return out.split('\n').filter(Boolean)
  }
  return null
}

const count = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).length : null)

// The first pass of a ticket, read from its journal: everything up to its first "ready", "no
// change". Later rounds (review comments, CI fixes) are left out on purpose.
export function passMetrics(t: Ticket, flowDir: string, touched: readonly string[] | null): PassMetrics {
  const journal = t.journal ?? []
  const end = journal.findIndex((j) => j.kind === 'ready' || j.kind === 'no_change')
  const pass = end >= 0 ? journal.slice(0, end + 1) : journal
  const sum = (key: string) => {
    const v = pass.map((j) => Number(j.meta?.[key])).filter((n) => Number.isFinite(n))
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100 : null
  }
  const started = t.events.find((e) => e.kind === 'start')?.at
  const ended = end >= 0 ? journal[end]?.at : undefined
  const stat = end >= 0 && journal[end]?.kind === 'ready' ? (journal[end]?.body ?? '').split('\n').at(-1) ?? '' : ''
  const num = (re: RegExp) => {
    const m = re.exec(stat)
    return m ? Number(m[1]) : end >= 0 && journal[end]?.kind === 'ready' ? 0 : null
  }
  const sup = [...pass].reverse().find((j) => j.title.startsWith('Supervisor'))
  const local = [...pass].reverse().find((j) => /^Local checks (passed|failed)/.test(j.title))
  const visual = [...pass].reverse().find((j) => j.title.startsWith('Visual check ·') || j.title.startsWith('Visual plan'))
  return {
    id: t.id,
    status: t.status,
    complete: end >= 0,
    cost: sum('cost'),
    tokens: sum('tokens'),
    minutes: started && ended ? Math.round((Date.parse(ended) - Date.parse(started)) / 6000) / 10 : null,
    laneMinutes: sum('minutes'),
    turns: pass.filter((j) => j.kind === 'run').length,
    rounds: pass.filter((j) => j.title.startsWith('Supervisor')).length,
    linesAdded: num(/(\d+) insertions?\(\+\)/),
    linesRemoved: num(/(\d+) deletions?\(-\)/),
    files: num(/(\d+) files? changed/),
    filesTouched: touched,
    supervisor: sup ? (sup.title.split('·').at(-1)?.replace(/\(round \d+\)/, '').trim() ?? null) : null,
    localChecks: local ? (local.title.startsWith('Local checks passed') ? 'passed' : 'failed') : null,
    visual: t.visual?.verdict ?? (visual ? visual.title : null),
    shots: count(path.join(flowDir, 'shots'), /\.(png|jpe?g|webp)$/i),
    videos: count(path.join(flowDir, 'videos'), /\.(mp4|webm|mov)$/i),
    ...(t.replay ? { settings: t.replay.settings } : {}),
    ...(started ? { at: started } : {}),
  }
}
