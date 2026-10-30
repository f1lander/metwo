import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlanFirst, Settings } from '@ticketflow/shared'

// Claude's model per lane; how hard it thinks is the global effort (pipeline.effort, the app, /effort).
interface ModelSpec {
  readonly model: string
}

export interface Config {
  readonly repo: {
    readonly path: string
    readonly baseBranch: string
    readonly worktreesDir: string
    // branch for each ticket; {id} is the Linear identifier, e.g. "linear/{id}" → linear/WEB-2049
    readonly branchPattern: string
    readonly commands: {
      readonly test: string
      readonly typecheck: string
      readonly lint: string
      readonly dev: string
      // started on its own port for story screenshots; the port is appended
      readonly storybook: string
      // run before the gates in a fresh checkout (PR reviews)
      readonly install: string
    }
  }
  // your team's docs clone, read before every lane (optional; same shape as a knowledge source)
  readonly wiki: {
    readonly path: string
    readonly alwaysRead: readonly string[]
    readonly byKeyword: Readonly<Record<string, readonly string[]>>
  }
  // more docs the lanes read: local folders, or git repos metwo clones into data/knowledge
  readonly knowledge: { readonly sources: readonly KnowledgeSource[]; readonly syncHours: number }
  // local services the app needs for browser checks; null = detect from the repo (apps-monorepo preset)
  readonly e2e: E2eConfig | null
  readonly linear: {
    readonly teamKey: string
    readonly watchStates: readonly string[]
    // state types watched on top of the names; "triage" catches issues assigned before triage ends
    readonly watchStateTypes: readonly string[]
    readonly moveToInProgressOnStart: boolean
    // workflow state names in your team, used by the QA / Done buttons
    readonly states: { readonly qa: string; readonly done: string; readonly inProgress: string }
    readonly comments: {
      readonly enabled: boolean
      // which moments post a comment on the Linear issue
      readonly on: readonly CommentMoment[]
      readonly signature: string
    }
  }
  readonly pipeline: {
    readonly pollMs: number
    readonly prSyncMs: number
    readonly maxParallel: number
    readonly portBase: number
    readonly autoStart: boolean
    readonly pushMode: 'ask' | 'auto'
    readonly reviewPass: boolean
    // local time "HH:MM" for the Telegram digest, or null to turn it off
    readonly digestAt: string | null
    // tried in order by "Open in editor"
    readonly editors: readonly string[]
    // where "Open in Claude" opens: auto (Warp, iTerm, Ghostty, then Terminal), or one of them
    readonly terminal: 'auto' | 'warp' | 'iterm' | 'ghostty' | 'terminal'
    // default effort for every lane and the review pass (the app and /effort can change it)
    readonly effort: 'low' | 'medium' | 'high'
    // a lane with no output for this long gets a "possibly stuck" warning
    readonly stuckMinutes: number
    // how often to fetch the base branch and count how far each open branch is behind
    readonly mainSyncMinutes: number
    // merge the base into open PRs that are behind and conflict free, then push if the gates pass
    readonly autoUpdateFromMain: boolean
  }
  readonly classifier: {
    readonly neverAuto: readonly string[]
    readonly fullLaneLabels: readonly string[]
    readonly autoLabels: readonly string[]
    readonly uiHints: readonly string[]
  }
  readonly models: {
    readonly lite: ModelSpec
    readonly full: ModelSpec
    readonly review: ModelSpec
  }
  readonly server: { readonly port: number; readonly tunnel: boolean }
  // other CLIs that can take a role; Claude is always available
  readonly engines: {
    readonly codex: { readonly enabled: boolean; readonly model: string }
    readonly cursor: { readonly enabled: boolean; readonly model: string }
    // provider/model, e.g. "opencode/grok-code" or "openrouter/qwen/qwen3-coder:free"; empty = opencode's default
    readonly opencode: { readonly enabled: boolean; readonly model: string }
    readonly hermes: { readonly enabled: boolean; readonly provider: string; readonly model: string }
  }
  // which engine does what: "claude", "codex", "cursor", "opencode", "hermes", optionally ":model"
  readonly roles: {
    readonly implementer: { readonly lite: string; readonly full: string }
    readonly reviewer: string
    // "off", "opposite" (another vendor than the implementer) or an engine
    readonly supervisor: string
    readonly supervisorRounds: number
    readonly visual: string
    // "off" or an engine; proposes team learnings from PR feedback once a day
    readonly curator: string
    readonly curatorAt: string
  }
  // small tickets start on their own (and Linear moves to In Progress); with autoPush a small
  // ticket that passes every check also gets its draft PR. Never marks a PR ready.
  readonly autopilot: { readonly enabled: boolean; readonly autoPush: boolean; readonly maxPerDay: number }
  // AI triage of the cycle: off = only when you press Triage; on = a few times a day, new and edited issues only
  readonly triage: { readonly auto: boolean }
  // API-priced USD as the CLIs report it. regulate lowers effort and moves to cheaper engines as
  // spend grows; from 90 % lite lanes and at the limit every new lane use `fallback` ("auto": the
  // first of codex, cursor, opencode, hermes). planFirst sends lanes there from the start.
  readonly budget: { readonly daily: number | null; readonly monthly: number | null; readonly regulate: boolean; readonly fallback: string; readonly planFirst: PlanFirst }
  readonly github: {
    // how screenshots and videos reach the PR: 'browser' attaches them through GitHub's own uploader
    // (metwo's signed-in browser profile, gist as backup), 'gist' a secret gist, 'none' not at all
    readonly screenshots: 'browser' | 'gist' | 'none'
    // on "ready for review", request GitHub's suggested reviewers
    readonly reviewers: { readonly auto: boolean; readonly max: number }
    readonly greptile: {
      readonly enabled: boolean
      // posted as a PR comment after the draft opens, and again after each push that follows a Greptile review
      readonly trigger: string
      readonly bot: string
    }
    // PRs you are asked to review: GitHub review requests and @mentions, PR links in Linear
    // mentions, or added by hand. `auto` starts the review as soon as one shows up.
    readonly reviews: { readonly requested: boolean; readonly mentions: boolean; readonly linear: boolean; readonly auto: boolean }
    // a QA round on the PR's preview deploy: offered (or started, with auto) when the PR gets `label`
    readonly qa: { readonly label: string; readonly auto: boolean }
  }
}

export interface KnowledgeSource {
  readonly name: string
  // a folder on this Mac, or a git URL (https or ssh) metwo clones and pulls
  readonly path?: string
  readonly git?: string
  readonly branch?: string
  // the page to read first, relative to the source (e.g. INDEX.md, README.md)
  readonly index?: string
  readonly alwaysRead?: readonly string[]
  // keyword in the ticket title or description → pages to read
  readonly byKeyword?: Readonly<Record<string, readonly string[]>>
  // pages applied as review lenses in the review pass and PR reviews
  readonly review?: readonly string[]
  // one line on what it is, shown to the lane
  readonly note?: string
}

export interface E2eConfig {
  // name → port that must be open
  readonly ports: Readonly<Record<string, number>>
  // the command that starts them, from the main checkout
  readonly up: string
  // what the lane should know to use them (wallet fixtures, test users)
  readonly notes: string
}

// apps-monorepo: Anvil fork, bundler and mocks, a headless wallet in e2e/
export const APPS_MONOREPO_E2E: E2eConfig = {
  ports: { anvil: 8545, bundler: 4337, mockestrator: 3007 },
  up: 'pnpm e2e:infra:up',
  notes: 'The e2e stack (Anvil fork + bundler + mocks) runs from the main checkout; a headless wallet is available through the fixtures in e2e/ (see e2e/README.md, "Wallet Authentication").',
}

export type CommentMoment = 'review_ready' | 'no_change' | 'pr_opened' | 'qa' | 'done' | 'failed'

// Every key except repo.path and linear.teamKey has a default, so a config file only
// needs what differs. Objects merge key by key; arrays and values replace.
const DEFAULTS: Config = {
  repo: {
    path: '',
    baseBranch: 'main',
    worktreesDir: '.worktrees',
    branchPattern: 'linear/{id}',
    commands: {
      test: '',
      typecheck: '',
      lint: '',
      dev: '',
      storybook: 'pnpm --filter=manager exec storybook dev --ci --no-open -p',
      install: 'pnpm install --frozen-lockfile',
    },
  },
  wiki: { path: '', alwaysRead: [], byKeyword: {} },
  knowledge: { sources: [], syncHours: 6 },
  e2e: null,
  linear: {
    teamKey: '',
    watchStates: ['Todo', 'In Progress'],
    watchStateTypes: ['triage'],
    moveToInProgressOnStart: false,
    states: { qa: 'QA', done: 'Done', inProgress: 'In Progress' },
    comments: {
      enabled: true,
      on: ['no_change', 'pr_opened', 'qa'],
      signature: 'Posted by the metwo agent on behalf of the ticket assignee, who reviews every change before it ships.',
    },
  },
  pipeline: {
    pollMs: 15_000,
    prSyncMs: 180_000,
    maxParallel: 2,
    portBase: 3100,
    autoStart: false,
    pushMode: 'ask',
    reviewPass: true,
    digestAt: '18:00',
    editors: ['cursor', 'code'],
    terminal: 'auto',
    effort: 'medium',
    stuckMinutes: 15,
    mainSyncMinutes: 15,
    autoUpdateFromMain: false,
  },
  classifier: {
    neverAuto: ['Security', 'High', 'Protocol', 'Needs Design'],
    fullLaneLabels: ['Bug', 'Security', 'High'],
    autoLabels: [],
    uiHints: ['overlap', 'align', 'spacing', 'padding', 'margin', 'copy', 'text', 'icon', 'color', 'banner', 'modal', 'layout', 'mobile', 'responsive', 'style', 'font', 'wrap'],
  },
  models: { lite: { model: 'opus' }, full: { model: 'opus' }, review: { model: 'opus' } },
  server: { port: 4747, tunnel: false },
  engines: {
    codex: { enabled: false, model: '' },
    cursor: { enabled: false, model: '' },
    opencode: { enabled: false, model: '' },
    hermes: { enabled: false, provider: 'openrouter', model: 'deepseek/deepseek-chat' },
  },
  roles: {
    implementer: { lite: 'claude', full: 'claude' },
    reviewer: 'claude',
    supervisor: 'opposite',
    supervisorRounds: 2,
    visual: 'claude',
    curator: 'off',
    curatorAt: '19:30',
  },
  autopilot: { enabled: false, autoPush: true, maxPerDay: 5 },
  triage: { auto: false },
  budget: { daily: null, monthly: null, regulate: true, fallback: 'auto', planFirst: 'off' },
  github: {
    screenshots: 'browser',
    reviewers: { auto: true, max: 2 },
    greptile: { enabled: true, trigger: '@greptile', bot: 'greptile-apps[bot]' },
    reviews: { requested: true, mentions: true, linear: true, auto: false },
    qa: { label: 'QA Requested', auto: false },
  },
}

export interface Env {
  readonly linearApiKey: string
  readonly telegramToken: string
  readonly telegramChatId: string
  readonly dataDir: string
  readonly rootDir: string
  readonly dashboardToken: string | null
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name} (see .env.example)`)
  return value
}

// The repo root, from this file's place in it (apps/daemon/src), wherever the daemon is started.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function loadEnv(): Env {
  return {
    linearApiKey: required('LINEAR_API_KEY'),
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    dataDir: path.resolve(ROOT, process.env.METWO_DATA_DIR ?? process.env.TICKETFLOW_DATA_DIR ?? 'data'),
    rootDir: ROOT,
    dashboardToken: process.env.DASHBOARD_TOKEN || null,
  }
}

type Json = Readonly<Record<string, unknown>>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function merge(base: Json, over: Json): Json {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v
  return out
}

// ticketflow.config.json over the defaults. Start from ticketflow.config.example.json.
export function loadConfig(rootDir: string): Config {
  const file = path.join(rootDir, 'ticketflow.config.json')
  if (!existsSync(file)) throw new Error(`no ticketflow.config.json in ${rootDir}: copy ticketflow.config.example.json and set your paths`)
  const cfg = merge(DEFAULTS as unknown as Json, JSON.parse(readFileSync(file, 'utf8')) as Json) as unknown as Config
  const missing = [
    ['repo.path', cfg.repo.path],
    ['linear.teamKey', cfg.linear.teamKey],
  ].filter(([, v]) => !v)
  if (missing.length) throw new Error(`ticketflow.config.json needs ${missing.map(([k]) => k).join(', ')}`)
  const e2e = cfg.e2e ?? detectE2e(cfg.repo.path)
  const withE2e = e2e === cfg.e2e ? cfg : { ...cfg, e2e }
  // the old switch for auto-starting small tickets is autopilot now
  return withE2e.pipeline.autoStart && !withE2e.autopilot.enabled ? { ...withE2e, autopilot: { ...withE2e.autopilot, enabled: true } } : withE2e
}

function detectE2e(repo: string): E2eConfig | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts?.['e2e:infra:up'] ? APPS_MONOREPO_E2E : null
  } catch {
    return null
  }
}

export function knowledgeDir(): string {
  return path.join(path.resolve(ROOT, process.env.METWO_DATA_DIR ?? process.env.TICKETFLOW_DATA_DIR ?? 'data'), 'knowledge')
}

// The config with what you changed in Settings on top.
export function effective(cfg: Config, s: Settings | undefined): Config {
  if (!s) return cfg
  const { since: _since, ...autopilot } = s.autopilot ?? {}
  const pipeline = { ...(s.effort ? { effort: s.effort } : {}), ...(s.maxParallel ? { maxParallel: s.maxParallel } : {}) }
  return merge(cfg as unknown as Json, { engines: s.engines ?? {}, roles: s.roles ?? {}, autopilot, budget: s.budget ?? {}, triage: s.triage ?? {}, pipeline } as Json) as unknown as Config
}
