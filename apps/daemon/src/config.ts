import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextBlock, PlanFirst, Settings, NightShiftConfig, RollCall, ShotRules, StepId, StepValues } from '@ticketflow/shared'
import { fromStages } from './stages.js'

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
    // the PR description: "builtin" (mevo's sections), "repo" (the repo's .github pull request
    // template when it has one), or a path in the repo
    readonly prTemplate: string
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
  // more docs the lanes read: local folders, or git repos mevo clones into data/knowledge
  // mcp: MCP servers the lanes have (added with `claude mcp add --scope user`) that hold team
  // context and shared skills, e.g. the ENS Labs one; the brief tells the lane to use them
  readonly knowledge: { readonly sources: readonly KnowledgeSource[]; readonly syncHours: number; readonly mcp: readonly string[] }
  // engineering principles (pstack) for the lanes, fetched at one pinned commit into data/knowledge/pstack.
  // Lists are relative to the repo's skills/ folder: a folder means its SKILL.md.
  readonly principles: {
    readonly enabled: boolean
    readonly git: string
    readonly ref: string
    readonly implement: readonly string[]
    readonly review: readonly string[]
    readonly prose: readonly string[]
    // read on top of `implement` by tickets that get that playbook (from labels, title and triage)
    readonly playbooks: { readonly bug: readonly string[]; readonly feature: readonly string[]; readonly refactor: readonly string[]; readonly perf: readonly string[]; readonly visual: readonly string[] }
  }
  // Figma frames linked in a ticket become the lane's design reference (needs FIGMA_TOKEN)
  readonly figma: { readonly enabled: boolean }
  readonly mascot: { readonly enabled: boolean; readonly coffee: boolean }
  readonly daemon: { readonly autoRestart: boolean }
  // small PRs a person can review: limits are null (none) until you set them in Settings.
  // sizeIgnore: globs left out of the count · security: regexes on added lines that call for the security lens
  readonly quality: { readonly targetLines: number | null; readonly maxLines: number | null; readonly minGreptile: number | null; readonly securityLens: boolean; readonly sizeIgnore: readonly string[]; readonly security: readonly string[]; readonly quick: string }
  // Slack: threads as context, DMs like Telegram, PR announcements, your mentions summarized
  readonly slack: { readonly threads: boolean; readonly notify: boolean; readonly announce: boolean; readonly channel: string; readonly mentions: boolean; readonly mentionsMinutes: number; readonly reviewSummaryAt: string; readonly rollCalls: readonly RollCall[]; readonly nightShift: NightShiftConfig; readonly autoNudge: boolean }
  // local services the app needs for browser checks; null = detect from the repo (apps-monorepo preset)
  readonly e2e: E2eConfig | null
  // what kind of app this is. web3: a wallet app (connect, signatures, transactions), which turns on
  // the wallet steps of the hand test and the visual check; null = yes when the e2e preset is found
  readonly project: { readonly name: string; readonly web3: boolean | null }
  // where tickets come from: Linear, or GitHub Issues in the repo (through gh). The linear block's
  // states and comments apply to both; teamKey and the watch lists are Linear's.
  readonly tracker: {
    readonly kind: 'linear' | 'github'
    readonly github: {
      // owner/name; empty = the repo's own GitHub remote
      readonly repo: string
      // only issues with all of these labels; empty = every open issue assigned to you
      readonly labels: readonly string[]
      // ticket ids are "<idPrefix>-<number>", e.g. GH-12
      readonly idPrefix: string
      // mirror In Progress, In Review and QA as "status: <name>" labels (Done closes the issue either way)
      readonly stateLabels: boolean
    }
  }
  readonly linear: {
    readonly teamKey: string
    // teams whose issues assigned to you show up on the board: [teamKey] by default, ["*"] for all.
    // Issues you take or add by link from any team are kept either way.
    readonly teams?: readonly string[]
    readonly watchStates: readonly string[]
    // state types watched on top of the names; "triage" catches issues assigned before triage ends
    readonly watchStateTypes: readonly string[]
    readonly moveToInProgressOnStart: boolean
    // workflow state names in your team, used by the QA / Done buttons
    readonly states: { readonly qa: string; readonly done: string; readonly inProgress: string; readonly inReview: string }
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
    // the first time a lane finishes and there is no PR yet, push and open the draft PR on its own
    readonly draftOnFinish: boolean
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
    // commits on the PR branch made on GitHub (its Update branch button, a teammate) come into the
    // worktree by themselves when it is a fast-forward; anything else waits for Pull from GitHub
    readonly autoPullPr: boolean
  }
  // per AI step: effort (null = pipeline.effort; quick defaults to low), extra instructions added to
  // its prompt, and context blocks turned off ({ "figma": false }); see STEP_CONTEXT
  readonly steps: { readonly [K in StepId]: StepValues }
  // the screenshots and video the lane takes; only the shots VISUAL.json names reach the PR
  readonly shots: ShotRules
  readonly classifier: {
    readonly neverAuto: readonly string[]
    readonly fullLaneLabels: readonly string[]
    readonly autoLabels: readonly string[]
    // small tickets with one of these start by themselves with autopilot, UI or not (support fixes)
    readonly startLabels: readonly string[]
    readonly uiHints: readonly string[]
  }
  readonly models: {
    readonly lite: ModelSpec
    readonly full: ModelSpec
    readonly review: ModelSpec
  }
  // macOS, opt-in: agents run under sandbox-exec with secrets unreadable (plus extra paths in hide)
  readonly security?: { readonly sandbox?: boolean; readonly hide?: readonly string[] }
  // host: 127.0.0.1 (default) keeps the API on this Mac; another address (a Tailscale IP) needs DASHBOARD_TOKEN
  readonly server: { readonly port: number; readonly tunnel: boolean; readonly host?: string }
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
  // before a ticket starts, a cheap read of it and its Linear discussion: ready, clarify or hold.
  // auto: checked when a ticket arrives and before autopilot starts it (autopilot waits below
  // minConfidence). engine: "auto" (OpenCode when enabled, else Claude haiku), "off", or a ref.
  readonly readiness: { readonly auto: boolean; readonly engine: string; readonly minConfidence: number }
  // before a PR is opened or pushed to: the gates and the e2e specs related to the change, run here.
  // A failure stops the push until you fix it or press Push anyway. e2e: "related" specs only,
  // "all" of the touched app's specs, or "off"; e2eMinutes caps one e2e run.
  // e2eAfterPr: also run e2e here once the PR exists (off: GitHub's CI runs them on every push)
  readonly localChecks: { readonly enabled: boolean; readonly e2e: 'related' | 'all' | 'off'; readonly e2eMinutes: number; readonly e2eAfterPr: boolean }
  // after a push that addresses review comments: reply "Addressed in <sha>" in each thread, resolve
  // the threads (off: many reviewers resolve their own), and ask the reviewers who requested
  // changes to review again once every one of their threads is answered
  readonly afterFix: { readonly reply: boolean; readonly resolve: boolean; readonly rerequest: boolean }
  // questions in the ticket chat: answered read-only from the ticket's record (HISTORY.md) and git,
  // no lane. The engine ref that answers; one that can't run read-only falls back to claude:sonnet.
  readonly chat: { readonly ask: string }
  // API-priced USD as the CLIs report it. regulate lowers effort and moves to cheaper engines as
  // spend grows; from 90 % lite lanes and at the limit every new lane use `fallback` ("auto": the
  // first of codex, cursor, opencode, hermes). planFirst sends lanes there from the start.
  readonly budget: { readonly daily: number | null; readonly monthly: number | null; readonly regulate: boolean; readonly fallback: string; readonly planFirst: PlanFirst }
  readonly github: {
    // how screenshots and videos reach the PR: 'browser' attaches them through GitHub's own uploader
    // (mevo's signed-in browser profile, gist as backup), 'gist' a secret gist, 'none' not at all
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
  // a folder on this Mac, or a git URL (https or ssh) mevo clones and pulls
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
  // how to run each app's e2e specs locally, the way CI does
  readonly apps?: readonly E2eApp[]
}

export interface E2eApp {
  readonly name: string
  // changes under these paths run this app's specs (the CI paths filter)
  readonly paths: readonly string[]
  // folder of *.spec.ts files, from the repo root
  readonly specs: string
  // started in the worktree; {port} is replaced
  readonly dev: string
  // env var that points the specs at the dev server
  readonly urlEnv: string
  // run in the worktree; {specs} are the spec files, space separated
  readonly test: string
  // env for the specs when the worktree has no e2e/.env (CI copies it the same way)
  readonly envFile?: string
}

// apps-monorepo: Anvil fork, bundler and mocks, a headless wallet in e2e/
export const APPS_MONOREPO_E2E: E2eConfig = {
  ports: { anvil: 8545, bundler: 4337, mockestrator: 3007 },
  up: 'pnpm e2e:infra:up',
  notes: 'The e2e stack (Anvil fork + bundler + mocks) runs from the main checkout; a headless wallet is available through the fixtures in e2e/ (see e2e/README.md, "Wallet Authentication").',
  // what .github/workflows/e2e.yml runs, one app at a time
  apps: [
    {
      name: 'manager',
      paths: ['apps/manager/', 'packages/', 'pnpm-lock.yaml', 'e2e/fixtures/', 'e2e/helpers/', 'e2e/projects/manager/'],
      specs: 'e2e/projects/manager/tests',
      dev: 'pnpm --filter manager dev --port {port} --mode ci',
      urlEnv: 'MANAGER_APP_URL',
      test: 'pnpm --filter @ens-apps/e2e exec playwright test --config=projects/manager/playwright.config.ts --pass-with-no-tests {specs}',
      envFile: 'e2e/.env.ci',
    },
    {
      name: 'portal',
      paths: ['apps/portal/', 'packages/', 'pnpm-lock.yaml', 'e2e/fixtures/', 'e2e/helpers/', 'e2e/projects/portal/'],
      specs: 'e2e/projects/portal/tests',
      dev: 'pnpm --filter portal dev --port {port} --mode ci',
      urlEnv: 'PORTAL_APP_URL',
      test: 'pnpm --filter @ens-apps/e2e exec playwright test --config=projects/portal/playwright.config.ts --pass-with-no-tests {specs}',
      envFile: 'e2e/.env.ci',
    },
  ],
}

export type CommentMoment = 'review_ready' | 'no_change' | 'pr_opened' | 'qa' | 'done' | 'failed'

// Every key except repo.path (and linear.teamKey with Linear) has a default, so a config file only
// needs what differs. Objects merge key by key; arrays and values replace.
export const SHOT_DEFAULTS: ShotRules = { mode: 'lane', speed: 1.5, max: 8, mobile: 'layout', before: 'changed', video: 'interactions', stories: 4 }

const DEFAULTS: Config = {
  repo: {
    path: '',
    baseBranch: 'main',
    worktreesDir: '.worktrees',
    branchPattern: 'linear/{id}',
    prTemplate: 'builtin',
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
  knowledge: { sources: [], syncHours: 6, mcp: [] },
  principles: {
    enabled: false,
    git: 'https://github.com/backnotprop/pstack.git',
    ref: '6c75f4e67546c2ddbf9634734c1e3ebbea34861a',
    implement: [
      'principle-laziness-protocol',
      'principle-subtract-before-you-add',
      'principle-foundational-thinking',
      'principle-model-the-domain',
      'principle-boundary-discipline',
      'principle-type-system-discipline',
      'principle-minimize-reader-load',
      'principle-test-behavior-not-implementation',
      'principle-prove-it-works',
      'typescript-best-practices',
    ],
    review: ['principle-minimize-reader-load', 'principle-laziness-protocol', 'principle-test-behavior-not-implementation', 'principle-type-system-discipline', 'principle-fix-root-causes', 'no-comments/references/comment-sicko.md'],
    prose: ['unslop'],
    playbooks: {
      bug: ['principle-fix-root-causes', 'principle-attack-the-premise', 'tdd'],
      feature: ['principle-sequence-verifiable-units'],
      refactor: ['principle-migrate-callers-then-delete-legacy-apis', 'principle-outcome-oriented-execution'],
      perf: ['principle-explain-the-number', 'benchmark-checklist'],
      visual: ['principle-experience-first'],
    },
  },
  figma: { enabled: true },
  mascot: { enabled: true, coffee: true },
  daemon: { autoRestart: true },
  quality: {
    // engine:model for quick fixes (small follow-ups you check by hand)
    quick: 'claude:sonnet',
    targetLines: null,
    maxLines: null,
    minGreptile: null,
    securityLens: true,
    sizeIgnore: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', '**/__snapshots__/**', '*.snap', '**/*.generated.*', '**/generated/**', '*.svg'],
    security: [
      '\\bsign(Message|TypedData|Transaction)\\b|\\bsigner\\b',
      'sendTransaction|writeContract|simulateContract|encodeFunctionData|estimateGas',
      '\\b(privateKey|mnemonic|seedPhrase)\\b',
      '\\bapprove\\(|permit\\b|allowance',
      'dangerouslySetInnerHTML|innerHTML|eval\\(|new Function\\(',
      'window\\.open|location\\.(href|assign|replace)|postMessage',
      'localStorage|sessionStorage|document\\.cookie',
      'signIn|signOut|authorization|accessToken|refreshToken|password',
    ],
  },
  slack: { threads: true, notify: false, announce: false, channel: '', mentions: false, mentionsMinutes: 5, reviewSummaryAt: '', rollCalls: [], autoNudge: false, nightShift: { enabled: false, mode: 'shadow', from: '22:00', to: '07:30', days: 'daily', followSlack: true, wake: [], dmAsMe: false } },
  e2e: null,
  project: { name: '', web3: null },
  tracker: { kind: 'linear', github: { repo: '', labels: [], idPrefix: 'GH', stateLabels: false } },
  linear: {
    teamKey: '',
    watchStates: ['Todo', 'In Progress'],
    watchStateTypes: ['triage'],
    moveToInProgressOnStart: false,
    states: { qa: 'QA', done: 'Done', inProgress: 'In Progress', inReview: 'In Review' },
    comments: {
      enabled: true,
      on: ['no_change', 'pr_opened', 'qa'],
      signature: 'Posted by the mevo agent on behalf of the ticket assignee, who reviews every change before it ships.',
    },
  },
  pipeline: {
    pollMs: 15_000,
    prSyncMs: 180_000,
    maxParallel: 2,
    portBase: 3100,
    autoStart: false,
    pushMode: 'ask',
    draftOnFinish: true,
    reviewPass: true,
    digestAt: '18:00',
    editors: ['cursor', 'code'],
    terminal: 'auto',
    effort: 'medium',
    stuckMinutes: 15,
    mainSyncMinutes: 15,
    autoUpdateFromMain: false,
    autoPullPr: true,
  },
  steps: {
    implement: { effort: null, instructions: '', context: {} },
    review: { effort: null, instructions: '', context: {} },
    supervisor: { effort: null, instructions: '', context: {} },
    visual: { effort: null, instructions: '', context: {} },
    quick: { effort: 'low', instructions: '', context: {} },
  },
  shots: SHOT_DEFAULTS,
  classifier: {
    neverAuto: ['Security', 'High', 'Protocol', 'Needs Design'],
    fullLaneLabels: ['Bug', 'Security', 'High'],
    autoLabels: [],
    startLabels: [],
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
  // autoPush off: autopilot stops at review ready and you push (turn it on in Settings)
  autopilot: { enabled: false, autoPush: false, maxPerDay: 5 },
  triage: { auto: false },
  readiness: { auto: true, engine: 'auto', minConfidence: 70 },
  localChecks: { enabled: true, e2e: 'related', e2eMinutes: 45, e2eAfterPr: false },
  afterFix: { reply: true, resolve: false, rerequest: true },
  chat: { ask: 'claude:sonnet' },
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
  // only needed when the tracker is Linear
  readonly linearApiKey: string | null
  readonly telegramToken: string
  readonly telegramChatId: string
  readonly dataDir: string
  readonly rootDir: string
  readonly dashboardToken: string | null
  readonly figmaToken: string | null
  // xoxb (posts DMs and announcements), xoxp (reads your mentions and threads), your member id (U0…)
  readonly slack: { readonly botToken: string | null; readonly userToken: string | null; readonly userId: string | null }
}

// The repo root, from this file's place in it (apps/daemon/src), wherever the daemon is started.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function loadEnv(): Env {
  return {
    linearApiKey: process.env.LINEAR_API_KEY || null,
    // optional: without them mevo runs without the Telegram bot
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    dataDir: path.resolve(ROOT, process.env.METWO_DATA_DIR ?? process.env.TICKETFLOW_DATA_DIR ?? 'data'),
    rootDir: ROOT,
    dashboardToken: process.env.DASHBOARD_TOKEN || null,
    figmaToken: process.env.FIGMA_TOKEN || null,
    slack: { botToken: process.env.SLACK_BOT_TOKEN || null, userToken: process.env.SLACK_USER_TOKEN || null, userId: process.env.SLACK_USER_ID || null },
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
  const cfg = merge(DEFAULTS as unknown as Json, fromStages(JSON.parse(readFileSync(file, 'utf8')) as Json)) as unknown as Config
  const missing = [
    ['repo.path', cfg.repo.path],
    ...(cfg.tracker.kind === 'linear' ? [['linear.teamKey', cfg.linear.teamKey]] : []),
  ].filter(([, v]) => !v)
  if (missing.length) throw new Error(`ticketflow.config.json needs ${missing.map(([k]) => k).join(', ')}`)
  const e2e = cfg.e2e ?? detectE2e(cfg.repo.path)
  const withE2e = { ...(e2e === cfg.e2e ? cfg : { ...cfg, e2e }), project: { ...cfg.project, web3: cfg.project.web3 ?? e2e !== null } }
  // the old switch for auto-starting small tickets is autopilot now
  const out = withE2e.pipeline.autoStart && !withE2e.autopilot.enabled ? { ...withE2e, autopilot: { ...withE2e.autopilot, enabled: true } } : withE2e
  return laneShots(out)
}

// steps mode is paused: the lane takes the screenshots, whatever the config or Settings say
function laneShots(cfg: Config): Config {
  return cfg.shots?.mode === 'steps' ? { ...cfg, shots: { ...cfg.shots, mode: 'lane' } } : cfg
}

// whether ticketflow.config.json describes the pipeline with a stages block
export function usesStages(rootDir: string): boolean {
  try {
    return 'stages' in (JSON.parse(readFileSync(path.join(rootDir, 'ticketflow.config.json'), 'utf8')) as Json)
  } catch {
    return false
  }
}

function detectE2e(repo: string): E2eConfig | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts?.['e2e:infra:up'] ? APPS_MONOREPO_E2E : null
  } catch {
    return null
  }
}

// a context block is on unless the step turns it off
export function ctxOn(cfg: Config, step: StepId, block: ContextBlock): boolean {
  return cfg.steps?.[step]?.context[block] !== false
}

export function knowledgeDir(): string {
  return path.join(path.resolve(ROOT, process.env.METWO_DATA_DIR ?? process.env.TICKETFLOW_DATA_DIR ?? 'data'), 'knowledge')
}

// The config with what you changed in Settings on top.
export function effective(cfg: Config, s: Settings | undefined): Config {
  if (!s) return cfg
  const { since: _since, ...autopilot } = s.autopilot ?? {}
  const pipeline = { ...(s.pipeline ?? {}), ...(s.effort ? { effort: s.effort } : {}), ...(s.maxParallel ? { maxParallel: s.maxParallel } : {}) }
  return laneShots(merge(cfg as unknown as Json, { engines: s.engines ?? {}, roles: s.roles ?? {}, autopilot, budget: s.budget ?? {}, triage: s.triage ?? {}, readiness: s.readiness ?? {}, localChecks: s.localChecks ?? {}, afterFix: s.afterFix ?? {}, chat: s.chat ?? {}, principles: s.principles ?? {}, slack: s.slack ?? {}, figma: s.figma ?? {}, mascot: s.mascot ?? {}, daemon: s.daemon ?? {}, quality: s.quality ?? {}, github: s.github ?? {}, steps: s.steps ?? {}, shots: s.shots ?? {}, pipeline } as Json) as unknown as Config)
}
