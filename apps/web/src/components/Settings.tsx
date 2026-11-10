import { type CheckState, ENGINE_SETUP, type EngineSetupStatus, type Health, type PlanFirst, type NightShiftConfig, type RollCall, type SettingsView, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { controls, loadSettings } from '../lib/api.js'
import { href, type SettingsTab } from '../lib/route.js'
import { type DaemonProcess, desktop, isDesktop } from '../lib/tauri.js'
import { Button, ConfirmButton, Dot, Mono, rise, Section, stagger, timeAgo } from './ui.js'
import { failed, notice } from '../lib/notice.js'
import { Mascot } from '@mevo/mascot/react'
import { PipelineTab } from './PipelineTab.js'
import { has, Panel, type Patch, type Reset, Row, type Run, type Save, Segmented, Select, TextField, Toggle, NumberField } from './settings-ui.js'

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'engines', label: 'Engines & budget' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'app', label: 'App' },
  { id: 'status', label: 'Status' },
]

// Everything you can change while mevo runs. Changes are saved in data/state.json and win over
// ticketflow.config.json; "reset" goes back to the file's value.
export function SettingsPage({ health, refresh, tab, tickets }: { health: Health | null; refresh: () => Promise<void>; tab: SettingsTab; tickets: readonly Ticket[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<SettingsView | null>(null)
  const reload = useCallback(async () => setView(await loadSettings().catch(() => null)), [])
  useEffect(() => {
    void reload()
  }, [reload])

  const run: Run = (key, fn) => async () => {
    setBusy(key)
    try {
      await fn()
      await Promise.all([refresh(), reload()])
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const save = (patch: Patch) => void run('save', () => controls.saveSettings(patch))()
  const reset = (key: string) => void run('save', () => controls.resetSetting(key))()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6 max-md:px-4 max-md:pb-28">
        <motion.div variants={rise} className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-muted">{health ? `daemon pid ${health.pid} · up ${timeAgo(health.startedAt)} · changes apply right away` : 'daemon is not answering'}</p>
          </div>
          <Button className="shrink-0 whitespace-nowrap" disabled={busy !== null} onClick={run('probe', () => controls.probe())}>
            <motion.span animate={busy === 'probe' ? { rotate: 360 } : { rotate: 0 }} transition={busy === 'probe' ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }} aria-hidden="true">
              ↻
            </motion.span>
            Check now
          </Button>
        </motion.div>

        <motion.nav variants={rise} className="flex gap-1 overflow-x-auto border-b border-line text-xs" aria-label="settings sections">
          {TABS.map((t) => (
            <a key={t.id} href={href.settings(t.id)} className={`relative -mb-px px-3 py-2 whitespace-nowrap ${tab === t.id ? 'text-fg' : 'text-muted hover:text-fg'}`}>
              {t.label}
              {tab === t.id && <motion.span layoutId="settings-tab" className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent-fg" />}
            </a>
          ))}
        </motion.nav>

        {!health || !view ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : tab === 'pipeline' ? (
          <PipelineTab health={health} view={view} busy={busy} run={run} save={save} reset={reset} tickets={tickets} />
        ) : tab === 'engines' ? (
          <>
            <EnginesTab health={health} view={view} save={save} reset={reset} />
            <Budget health={health} view={view} save={save} reset={reset} />
          </>
        ) : tab === 'app' ? (
          <AppTab view={view} save={save} reset={reset} />
        ) : tab === 'integrations' ? (
          <Integrations health={health} busy={busy} run={run} view={view} save={save} reset={reset} />
        ) : (
          <StatusTab health={health} busy={busy} setBusy={setBusy} run={run} refresh={refresh} />
        )}
      </motion.div>
    </div>
  )
}

// --- tabs ---------------------------------------------------------------------------------

function AppTab({ view, save, reset }: { view: SettingsView; save: Save; reset: Reset }) {
  const o = view.overrides
  return (
    <>
      <Panel title="Mo" hint="The o of the logo, out in the app: he is the Tell the agent button, reacts to merges, failures and questions, and sleeps during Night Shift. Drag him to any corner; ✕ puts him back in the logo and a click on the logo brings him out.">
        <Row label="Show Mo" hint="Off: the classic Tell the agent button." changed={has(o.mascot, 'enabled')} onReset={() => reset('mascot.enabled')}>
          <Mascot state="idle" width={34} />
          <Toggle label="show mo" on={view.effective.mascot.enabled} onChange={(v) => save({ mascot: { enabled: v } })} />
        </Row>
        <Row label="Coffee game" hint="Closing an issue costs 18% of his coffee and every lane turn 3%. Click him a few times in a row to refill. At 0% no new lane starts (from here, Telegram or autopilot) until he gets coffee; lanes already running finish." changed={has(o.mascot, 'coffee')} onReset={() => reset('mascot.coffee')}>
          <Toggle label="coffee game" on={view.effective.mascot.coffee} onChange={(v) => save({ mascot: { coffee: v } })} />
        </Row>
      </Panel>
      <Panel title="Daemon">
        <Row label="Restart for new code" hint="When mevo's code changes on disk (a pull, a fix), it restarts by itself as soon as no lane, check or hand test is running, so nothing runs on old code. Only when the desktop app runs mevo; from a terminal the app just tells you." changed={has(o.daemon, 'autoRestart')} onReset={() => reset('daemon.autoRestart')}>
          <Toggle label="restart for new code" on={view.effective.daemon.autoRestart} onChange={(v) => save({ daemon: { autoRestart: v } })} />
        </Row>
      </Panel>
    </>
  )
}

const LEVEL: Record<string, { label: string; tone: string; what: string }> = {
  normal: { label: 'Normal', tone: 'text-ok', what: 'Lanes run as configured.' },
  saver: { label: 'Saving', tone: 'text-warn', what: 'Effort capped at medium, lite tickets skip the extra review pass.' },
  tight: { label: 'Tight', tone: 'text-warn', what: 'Lite runs on low effort, full on medium.' },
  over: { label: 'Over budget', tone: 'text-bad', what: 'New lanes run on the fallback engine; Claude only for tickets you pin to it. Autopilot stops when there is no fallback.' },
}

function Meter({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  const share = limit ? Math.min(spent / limit, 1) : 0
  const color = !limit ? 'bg-line-2' : share >= 1 ? 'bg-bad' : share >= 0.6 ? 'bg-warn' : 'bg-accent-fg'
  return (
    <div className="flex flex-1 basis-56 flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">
          <span className="text-lg font-semibold text-fg">${spent.toFixed(2)}</span>
          <span className="text-dim"> {limit ? `of $${limit}` : 'no limit'}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-sunk">
        <motion.div initial={{ width: 0 }} animate={{ width: `${share * 100}%` }} className={`h-full rounded-full ${color}`} />
      </div>
    </div>
  )
}

function Budget({ health, view, save, reset }: { health: Health; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const b = health.lanes.budget
  const v = view.effective.budget
  const o = view.overrides.budget
  const enabled = (health.lanes.engines ?? []).filter((e) => e.id !== 'claude').map((e) => e.id)
  const level = LEVEL[b?.level ?? 'normal'] ?? LEVEL.normal
  return (
    <>
      <motion.section variants={rise} className="flex flex-col gap-4 rounded-lg border border-line bg-panel px-4 py-4">
        <div className="flex flex-wrap gap-6">
          <Meter label="Today" spent={b?.day.spent ?? 0} limit={v.daily} />
          <Meter label="This month" spent={b?.month.spent ?? 0} limit={v.monthly} />
        </div>
        <p className="text-xs">
          <span className={`font-medium ${level?.tone}`}>{level?.label}</span>
          <span className="text-muted"> · {v.regulate ? level?.what : 'Regulation is off: lanes always run as configured.'}</span>
        </p>
      </motion.section>

      <Panel title="Limits" hint="Spend is the cost each CLI reports. Claude prices its turns at API rates even on a plan, so it works as a usage meter; Codex and Cursor report none (they use your plan). Alerts arrive in Telegram at 50, 80 and 100 %.">
        <Row label="Per day" hint="Empty: no daily limit." changed={has(o, 'daily')} onReset={() => reset('budget.daily')}>
          <NumberField label="daily budget" prefix="$" placeholder="none" value={v.daily} onSave={(n) => save({ budget: { daily: n } })} />
        </Row>
        <Row label="Per month" hint="Empty: no monthly limit." changed={has(o, 'monthly')} onReset={() => reset('budget.monthly')}>
          <NumberField label="monthly budget" prefix="$" placeholder="none" value={v.monthly} onSave={(n) => save({ budget: { monthly: n } })} />
        </Row>
      </Panel>

      <Panel title="Use your plans first" hint="Codex and Cursor run on your ChatGPT or Cursor subscription and OpenCode can run free models, so a lane there costs nothing extra. Send lanes to them before Claude spends API-priced budget.">
        <Row label="Plan first" hint={`Lanes you pin to an engine keep it. ${b?.fallback ? `Goes to: ${b.fallback}.` : 'No plan engine enabled yet: turn one on in Engines.'}`} changed={has(o, 'planFirst')} onReset={() => reset('budget.planFirst')}>
          <Segmented<PlanFirst> label="plan first" value={v.planFirst} options={['off', 'lite', 'all']} onChange={(x) => save({ budget: { planFirst: x } })} />
        </Row>
      </Panel>

      <Panel title="Regulation" hint="As spend grows: from 60 % effort is capped at medium and lite skips the review pass; from 90 % lite runs on low on the plan engine; at 100 % every new lane moves there.">
        <Row label="Regulate lanes" changed={has(o, 'regulate')} onReset={() => reset('budget.regulate')}>
          <Toggle label="regulate" on={v.regulate} onChange={(x) => save({ budget: { regulate: x } })} />
        </Row>
        <Row
          label="Plan engine"
          hint={`Where plan-first and budget-saving lanes run: a flat plan (Codex, Cursor) or a free model (OpenCode, Hermes with an OpenRouter :free model). ${b?.fallback ? `Now: ${b.fallback}.` : 'None enabled yet: turn one on in Engines.'}`}
          changed={has(o, 'fallback')}
          onReset={() => reset('budget.fallback')}
        >
          <Select
            label="fallback engine"
            value={v.fallback}
            onChange={(x) => save({ budget: { fallback: x } })}
            options={[{ value: 'auto', label: 'First enabled (Codex, Cursor, OpenCode, Hermes)' }, ...['codex', 'cursor', 'opencode', 'hermes'].map((e) => ({ value: e, label: `${e}${enabled.includes(e) ? '' : ' (not enabled)'}` })), { value: 'off', label: 'None: keep Claude' }]}
          />
        </Row>
      </Panel>
    </>
  )
}

function EnginesTab({ health, view, save, reset }: { health: Health; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const e = view.effective.engines
  const o = view.overrides.engines
  const r = view.effective.roles
  const ro = view.overrides.roles
  const status = new Map((health.lanes.engines ?? []).map((x) => [x.id, x]))
  const enabled = ['claude', ...(['codex', 'cursor', 'opencode', 'hermes'] as const).filter((id) => e[id].enabled)]
  const engineOptions = enabled.map((id) => ({ value: id, label: id }))
  const role = (key: 'curator', extra: readonly { value: string; label: string }[], label: string, hint: string) => (
    <Row label={label} hint={hint} changed={has(ro, key)} onReset={() => reset(`roles.${key}`)}>
      <Select label={label} value={r[key]} options={[...extra, ...engineOptions]} onChange={(v) => save({ roles: { [key]: v } })} />
    </Row>
  )
  return (
    <>
      <Panel title="Engines" hint="Each one is a CLI on this Mac, signed in with your account. Turn one on, then Install and Sign in from its row if it needs it.">
        <EngineRow id="claude" label="Claude Code" status={status.get('claude')} always />
        {(['codex', 'cursor', 'opencode', 'hermes'] as const).map((id) => (
          <EngineRow key={id} id={id} label={{ codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', hermes: 'Hermes' }[id]} status={status.get(id)}>
            <Toggle label={`${id} enabled`} on={e[id].enabled} onChange={(v) => save({ engines: { [id]: { enabled: v } } })} />
            {id === 'hermes' && <TextField label="hermes provider" width="w-28" value={e.hermes.provider} placeholder="openrouter" onSave={(v) => save({ engines: { hermes: { provider: v } } })} />}
            <TextField label={`${id} model`} width="w-48" value={e[id].model} placeholder={id === 'opencode' ? 'provider/model' : 'CLI default'} onSave={(v) => save({ engines: { [id]: { model: v } } })} />
            {has(o, id) && (
              <button type="button" onClick={() => reset(`engines.${id}`)} className="rounded bg-raised px-1.5 py-px text-[10px] text-muted hover:text-fg">
                reset
              </button>
            )}
          </EngineRow>
        ))}
      </Panel>

      <Panel title="Other roles" hint="The engines for the pipeline's own steps are in Pipeline, stage by stage. A role on an engine that is turned off falls back to Claude.">
        <Row label="Questions in the ticket chat" hint="Ask mode answers from the ticket's history (commits, review threads, checks) and read-only git. No lane runs and nothing changes." changed={has(view.overrides.chat, 'ask')} onReset={() => reset('chat.ask')}>
          <Select label="chat engine" value={view.effective.chat.ask} options={[{ value: 'claude:sonnet', label: 'Claude Sonnet' }, { value: 'claude:haiku', label: 'Claude Haiku' }, { value: 'claude:opus', label: 'Claude Opus' }, { value: 'codex', label: 'Codex (read-only)' }]} onChange={(v) => save({ chat: { ask: v } })} />
        </Row>
        {role('curator', [{ value: 'off', label: 'off' }], 'Learnings curator', 'Reads PR feedback once a day and proposes team rules.')}
      </Panel>
    </>
  )
}

function EngineRow({ id, label, status, always = false, children }: { id: string; label: string; status: NonNullable<Health['lanes']['engines']>[number] | undefined; always?: boolean; children?: ReactNode }) {
  const [result, setResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const test = async () => {
    setTesting(true)
    try {
      const r = await controls.testEngine(id)
      setResult(`${r.ok ? '✓' : '✕'} ${r.detail}${r.model ? ` · ${r.model}` : ''} · ${r.seconds}s`)
    } catch (err) {
      setResult(`✕ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs">
      <Dot ok={status ? status.installed && status.signedIn !== false : always ? true : null} />
      <span className="w-24 font-medium text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate text-dim">{status ? (status.installed ? `${status.version ?? 'installed'} · ${status.detail}` : 'not installed') : always ? 'always on' : 'off'}</span>
      <span className="flex flex-wrap items-center gap-2">
        {children}
        <Button variant="ghost" disabled={testing || !status?.installed} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </span>
      {status && <EngineSetupBar id={id} status={status} />}
      {status && status.roles.length > 0 && (
        <span className="w-full pl-[22px] text-[11px] text-muted">
          {status.roles.join(' · ')}
        </span>
      )}
      {result && <span className="w-full pl-[22px] font-mono text-[11px] text-fg-2">{result}</span>}
    </div>
  )
}

function Integrations({ health, busy, run, view, save, reset }: { health: Health; busy: string | null; run: Run; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const sl = view.effective.slack
  const so = view.overrides.slack
  const slackCheck = health.slack ?? { ok: null, detail: 'add the Slack tokens to .env', at: null }
  const figmaCheck = health.figma ?? { ok: null, detail: 'add FIGMA_TOKEN to .env', at: null }
  return (
    <>
    <Panel
      title="Figma"
      hint="When a ticket links a Figma frame, the daemon renders it and reads its spec (sizes, spacing, colors, type, components) with your token, and the lane builds against it. The visual check and the supervisor compare the result with it. UI tickets without a link get a note."
    >
      <Row label="Use Figma links in tickets" hint={<span className={figmaCheck.ok === false ? 'text-bad' : ''}>{figmaCheck.detail}</span>} changed={has(view.overrides.figma, 'enabled')} onReset={() => reset('figma.enabled')}>
        <Toggle label="figma" on={view.effective.figma.enabled} onChange={(v) => save({ figma: { enabled: v } })} />
      </Row>
    </Panel>
    <Panel
      title="Slack"
      hint={
        <>
          <span className={slackCheck.ok === false ? 'text-bad' : ''}>{slackCheck.detail}</span>. Each part is its own switch. Tokens live in .env (SLACK_BOT_TOKEN, SLACK_USER_TOKEN, SLACK_USER_ID); see .env.example for the scopes.
        </>
      }
    >
      <Row label="Read linked threads" hint="A Slack thread linked in a ticket goes to the lane as context, like Linear comments." changed={has(so, 'threads')} onReset={() => reset('slack.threads')}>
        <Toggle label="slack threads" on={sl.threads} onChange={(v) => save({ slack: { threads: v } })} />
      </Row>
      <Row label="Notifications by DM" hint="What Telegram sends you, also as Slack DMs from the bot, with links to the PR, Linear and the app." changed={has(so, 'notify')} onReset={() => reset('slack.notify')}>
        <Toggle label="slack notifications" on={sl.notify} onChange={(v) => save({ slack: { notify: v } })} />
      </Row>
      <Row label="Post PRs ready for review" hint="When a PR of yours leaves draft (here or on GitHub), post it to this channel with its size, checks and Greptile score." changed={has(so, 'announce') || has(so, 'channel')} onReset={() => (reset('slack.announce'), reset('slack.channel'))}>
        <TextField label="slack channel" value={sl.channel} placeholder="#web-prs or C0123…" width="w-40" onSave={(v) => save({ slack: { channel: v } })} />
        <Toggle label="announce PRs" on={sl.announce} onChange={(v) => save({ slack: { announce: v } })} />
      </Row>
      <Row label="Roll call" hint="Your PRs waiting for review (link, Linear id, CI, who is asked or owes a re-review) go to Slack at these times, as the bot. If nothing changed since the last post in that channel, it skips. Times are this computer's. Post one by hand from Today." changed={has(so, 'rollCalls') || has(so, 'reviewSummaryAt')} onReset={() => (reset('slack.rollCalls'), reset('slack.reviewSummaryAt'))}>
        <RollCalls value={sl.rollCalls?.length ? sl.rollCalls : sl.reviewSummaryAt ? [{ at: sl.reviewSummaryAt, days: 'weekdays' }] : []} fallback={sl.channel} onSave={(rollCalls) => save({ slack: { rollCalls, reviewSummaryAt: '' } })} />
      </Row>
      <Row label="Auto nudge" hint="Reviewers to nudge get the DM by themselves (as you, the same text Nudge drafts): only in their working hours on weekdays (8:00 to 19:00 their time), at most once a day each, after the PR has waited 4 hours. Telegram tells you who was nudged. Needs SLACK_USER_TOKEN." changed={has(so, 'autoNudge')} onReset={() => reset('slack.autoNudge')}>
        <Toggle label="auto nudge" on={sl.autoNudge ?? false} onChange={(v) => save({ slack: { autoNudge: v } })} />
      </Row>
      <Row label="Summarize my mentions" hint="Every few minutes, threads where someone tagged you are read and summarized with what you should do, on Today and by DM and Telegram. Each summary is a small model call." changed={has(so, 'mentions')} onReset={() => reset('slack.mentions')}>
        <Toggle label="slack mentions" on={sl.mentions} onChange={(v) => save({ slack: { mentions: v } })} />
      </Row>
      <NightShiftRows value={sl.nightShift} changed={has(so, 'nightShift')} reset={() => reset('slack.nightShift')} save={(nightShift) => save({ slack: { nightShift } })} />
    </Panel>
    <motion.div variants={stagger} className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <Card title="Telegram bot" check={health.telegram} extra={health.telegram.bot}>
        <Button disabled={busy !== null} onClick={run('bot', () => controls.restartBot())}>
          {busy === 'bot' ? 'Restarting…' : 'Restart bot'}
        </Button>
      </Card>
      <Card title="Linear" check={health.linear} extra={health.linear.lastPollAt ? `last poll ${timeAgo(health.linear.lastPollAt)} ago · ${health.linear.tracked} tracked` : null}>
        <Button disabled={busy !== null} onClick={run('poll', () => controls.poll())}>
          {busy === 'poll' ? 'Polling…' : 'Poll now'}
        </Button>
      </Card>
      <Card title="GitHub" check={health.github} />
      {health.uploads && (
        <Card title="GitHub uploads" check={health.uploads} extra={health.uploads.login ? `browser profile signed in as ${health.uploads.login}` : 'screenshots and videos attach to PRs through a signed-in browser'}>
          <Button disabled={busy !== null} title="opens a Chrome window on the Mac" onClick={run('ghlogin', () => controls.githubLogin())}>
            {health.uploads.login ? 'Sign in again' : 'Sign in to GitHub'}
          </Button>
        </Card>
      )}
      <Card title="PR sync" check={health.prSync} />
      {health.mainSync && <Card title="Main sync" check={health.mainSync} extra="fetches main every few minutes; behind branches show an Update button" />}
      {health.reviews && <Card title="Review requests" check={health.reviews} extra="GitHub review requests and mentions, PR links in Linear mentions" />}
      <Card title="Claude" check={health.claude} />
      <Card title="E2E stack" check={health.e2e} extra={Object.entries(health.e2e.ports).map(([k, up]) => `${k} ${up ? '●' : '○'}`).join('  ') || null} />
      <Card title="Tunnel" check={health.tunnel} extra={health.tunnel.url}>
        {health.tunnel.url && (
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(health.tunnel.url ?? '')}>
            Copy URL
          </Button>
        )}
        <ConfirmButton
          label="Sign out phones"
          confirm="Sign out every phone and browser"
          onConfirm={() => void controls.revokeSessions().then((r) => notice({ title: `Signed out ${r.revoked} session${r.revoked === 1 ? '' : 's'}`, detail: 'Telegram /tunnel gives a new one-time link', tone: 'accent' }), (e: unknown) => failed(e))}
        />
      </Card>
    </motion.div>
    </>
  )
}

function StatusTab({ health, busy, setBusy, run, refresh }: { health: Health; busy: string | null; setBusy: (b: string | null) => void; run: Run; refresh: () => Promise<void> }) {
  const checks: readonly [string, CheckState][] = [
    ['Telegram', health.telegram],
    ['Linear', health.linear],
    ['GitHub', health.github],
    ['Claude', health.claude],
    ['PR sync', health.prSync],
    ['E2E', health.e2e],
  ]
  return (
    <>
      <motion.section variants={rise} className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-line bg-panel px-4 py-3 text-xs">
        {checks.map(([name, c]) => (
          <span key={name} className="flex items-center gap-1.5" title={c.detail}>
            <Dot ok={c.ok} />
            {name}
          </span>
        ))}
        <span className="ml-auto text-muted">
          {health.lanes.active.length}/{health.lanes.max} lanes{health.lanes.paused ? ' · paused' : ''}
        </span>
      </motion.section>
      <StopEverything health={health} busy={busy} run={run} />
      {isDesktop && <DaemonProcessCard busy={busy} setBusy={setBusy} refresh={refresh} />}
    </>
  )
}

function Card({ title, check, extra, children }: { title: string; check: CheckState; extra?: string | null; children?: ReactNode }) {
  return (
    <motion.div
      variants={rise}
      layout
      whileHover={{ y: -2 }}
      className={`flex flex-col gap-2 rounded-lg border bg-panel px-4 py-3 transition-colors duration-500 ${check.ok === false ? 'border-[#4a2a2f]' : 'border-line'}`}
    >
      <div className="flex items-center gap-2">
        <Dot ok={check.ok} pulse />
        <span className="font-medium">{title}</span>
        {check.at && <span className="ml-auto text-[11px] text-dim">{timeAgo(check.at)} ago</span>}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p key={check.detail} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`text-xs leading-snug ${check.ok === false ? 'text-bad' : 'text-fg-2'}`}>
          {check.detail}
        </motion.p>
      </AnimatePresence>
      {extra && <Mono className="truncate text-muted">{extra}</Mono>}
      {children && <div className="flex gap-2">{children}</div>}
    </motion.div>
  )
}

function DaemonProcessCard({ busy, setBusy, refresh }: { busy: string | null; setBusy: (b: string | null) => void; refresh: () => Promise<void> }) {
  const [proc, setProc] = useState<DaemonProcess | null>(null)
  const [logs, setLogs] = useState<readonly string[]>([])
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const tick = async () => {
      setProc(await desktop.status().catch(() => null))
      setLogs(await desktop.logs().catch(() => []))
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [logs.length])

  const act = (key: string, fn: () => Promise<DaemonProcess>, confirmText?: string) => async () => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(key)
    try {
      setProc(await fn())
      setTimeout(() => void refresh(), 2500)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const killWarning = 'Restarting the daemon stops any lane that is running right now. Continue?'

  return (
    <Section
      title="Daemon process"
      className="max-md:[&>div:first-child]:flex-col max-md:[&>div:first-child]:items-start max-md:[&>div:first-child]:gap-2"
      right={
        <div className="flex gap-2">
          {proc?.external ? null : proc?.running ? (
            <>
              <Button disabled={busy !== null} onClick={act('restart', desktop.restart, killWarning)}>
                {busy === 'restart' ? 'Restarting…' : 'Restart daemon'}
              </Button>
              <Button variant="danger" disabled={busy !== null} onClick={act('stop', desktop.stop, killWarning)}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={busy !== null} onClick={act('start', desktop.start)}>
              {busy === 'start' ? 'Starting…' : 'Start daemon'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex items-center gap-2 text-xs text-fg-2">
        <Dot ok={proc?.running ?? null} pulse />
        {proc?.external
          ? 'running from a terminal · stop it there (Ctrl+C) to let the app manage it'
          : proc?.running
            ? `running · pid ${proc.pid} · since ${proc.startedAt ? new Date(proc.startedAt).toLocaleTimeString([], { hour12: false }) : '—'}`
            : `stopped${proc?.exitCode != null ? ` · exit ${proc.exitCode}` : ''}`}
        {proc && <Mono className="ml-auto text-dim">{proc.root}</Mono>}
      </div>
      <pre ref={box} className="h-56 overflow-auto rounded-lg border border-line bg-sunk px-3 py-2.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-muted">
        {logs.length ? logs.join('\n') : 'no output yet'}
      </pre>
    </Section>
  )
}

// The emergency brake: every lane killed and parked with a RESUME.md, the queue paused, and
// data/pending.md listing what is left. Optionally the daemon goes down too.
function StopEverything({ health, busy, run }: { health: Health; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => () => Promise<void> }) {
  const [result, setResult] = useState<string | null>(null)
  const go = (shutdown: boolean) =>
    run(shutdown ? 'shutdown' : 'stopall', async () => {
      const r = await controls.stopAll(shutdown)
      setResult(shutdown ? 'Stopped. The daemon is shutting down.' : `Stopped ${r.stopped.length ? r.stopped.join(', ') : 'nothing (no lane was running)'}. Lanes are paused. Pending work: ${r.pending}`)
    })
  return (
    <motion.section variants={rise} className="flex flex-wrap items-center gap-3 rounded-lg border border-[#4a2a2f] bg-[#1b1416] px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium">Stop everything</h2>
        <p className="text-xs text-muted">
          {health.lanes.active.length ? `${health.lanes.active.length} lane(s) running.` : 'No lane running.'} Kills every lane and the dev servers it started, saves a RESUME.md per ticket, pauses the queue and writes data/pending.md.
        </p>
        {result && <p className="mt-1 text-xs text-fg-2">{result}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <ConfirmButton variant="danger" label="Stop all lanes" confirm="Yes, stop them" disabled={busy !== null} onConfirm={() => void go(false)()} />
        <ConfirmButton variant="ghost" label="Stop and shut down" confirm="Yes, shut down" disabled={busy !== null} onConfirm={() => void go(true)()} />
      </div>
    </motion.section>
  )
}

// Install from mevo, sign in in your terminal (it is interactive), or copy either command.
function EngineSetupBar({ id, status }: { id: string; status: NonNullable<Health['lanes']['engines']>[number] }) {
  const setup = ENGINE_SETUP[id]
  const [job, setJob] = useState<EngineSetupStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (job?.state !== 'installing') return
    const t = setInterval(async () => {
      const all = await controls.engineSetup().catch(() => [])
      const mine = all.find((s) => s.id === id)
      if (mine) setJob(mine)
      if (mine && mine.state !== 'installing') await controls.probe().catch(() => undefined)
    }, 1500)
    return () => clearInterval(t)
  }, [job?.state, id])
  if (!setup) return null
  const needsInstall = !status.installed
  const needsLogin = status.installed && status.signedIn === false
  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(cmd)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setNote(cmd)
    }
  }
  const term = async (step: 'install' | 'login') => {
    try {
      const r = await controls.engineTerminal(id, step)
      setNote(step === 'login' ? `Opened ${r.app}. Sign in there${setup.loginHint ? ` (${setup.loginHint})` : ''}, then press Check again.` : `Opened ${r.app} with the install running.`)
    } catch (err) {
      failed(err)
    }
  }
  const install = async () => {
    try {
      setJob((await controls.installEngine(id)).status)
    } catch (err) {
      failed(err)
    }
  }
  const cmd = (c: string) => (
    <span className="flex min-w-0 items-center gap-1.5">
      <Mono className="truncate rounded bg-sunk px-1.5 py-0.5 text-fg-2">{c}</Mono>
      <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => void copy(c)}>
        {copied === c ? 'copied' : 'copy'}
      </button>
    </span>
  )
  if (!needsInstall && !needsLogin && job?.state !== 'failed') {
    return setup.login ? (
      <span className="w-full pl-[22px] text-[11px] text-dim">
        <button type="button" className="hover:text-fg" onClick={() => void term('login')}>
          Sign in again
        </button>
        {note && <span className="ml-2 text-fg-2">{note}</span>}
      </span>
    ) : null
  }
  return (
    <div className="ml-[22px] flex w-full flex-col gap-2 rounded-md border border-[#3d3522] bg-[#1a1812] px-3 py-2.5">
      <span className="text-[11.5px] text-warn">{needsInstall ? 'Turned on but not installed on this Mac: its roles fall back to another engine until you install it.' : 'Installed but not signed in.'}</span>
      {needsInstall && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">1. Install</span>
          {cmd(setup.install)}
          <ConfirmButton
            variant="default"
            disabled={job?.state === 'installing'}
            label={job?.state === 'installing' ? 'Installing…' : 'Install'}
            confirm={`Run "${setup.install}" from ${installSource(setup.install)}`}
            onConfirm={() => void install()}
          />
          <Button variant="ghost" onClick={() => void term('install')}>
            In my terminal
          </Button>
        </div>
      )}
      {setup.login && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">{needsInstall ? '2.' : '1.'} Sign in</span>
          {cmd(setup.login)}
          <Button variant={needsLogin ? 'primary' : 'default'} disabled={needsInstall && job?.state !== 'done'} onClick={() => void term('login')}>
            Sign in in my terminal
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => void controls.probe()}>
          Check again
        </Button>
        {job?.state === 'done' && <span className="text-[11px] text-ok">Installed.{setup.login ? ' Now sign in.' : ''}</span>}
        {job?.state === 'failed' && <span className="text-[11px] text-bad">The install failed. Try it in your terminal.</span>}
      </div>
      {job && job.output.trim() && job.state !== 'done' && <pre className="max-h-32 overflow-auto rounded bg-sunk px-2 py-1.5 font-mono text-[10.5px] whitespace-pre-wrap text-muted">{job.output.trim().split('\n').slice(-12).join('\n')}</pre>}
      {note && <span className="text-[11px] text-fg-2">{note}</span>}
    </div>
  )
}

// where an install command downloads from, said before it runs
function installSource(cmd: string): string {
  const url = /https?:\/\/([^/\s]+)/.exec(cmd)?.[1]
  if (url) return url
  if (/^npm i/.test(cmd)) return `npm (${cmd.split(' ').pop() ?? ''})`
  return 'your shell'
}

// The Roll call times: each with its days and, if not the default one, its channel.
function RollCalls({ value, fallback, onSave }: { value: readonly RollCall[]; fallback: string; onSave: (v: RollCall[]) => void }) {
  const [list, setList] = useState<RollCall[]>(() => [...value])
  useEffect(() => setList([...value]), [value])
  const field = 'rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  const change = (i: number, patch: Partial<RollCall>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const dirty = JSON.stringify(list) !== JSON.stringify(value)
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((rc, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <input type="time" aria-label="time" value={rc.at} onChange={(e) => change(i, { at: e.target.value })} className={`${field} w-[7.5rem]`} />
          <select aria-label="days" value={rc.days} onChange={(e) => change(i, { days: e.target.value as RollCall['days'] })} className={field}>
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
          </select>
          <input aria-label="channel" value={rc.channel ?? ''} placeholder={fallback || '#channel'} onChange={(e) => change(i, e.target.value.trim() ? { channel: e.target.value } : { channel: '' })} className={`${field} w-36`} />
          <button type="button" aria-label="remove this time" className="px-1 text-muted hover:text-bad" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        {list.length < 6 && (
          <button type="button" className="text-xs text-accent-fg hover:underline" onClick={() => setList((l) => [...l, { at: '09:00', days: 'weekdays' }])}>
            + Add a time
          </button>
        )}
        {dirty && (
          <Button variant="primary" onClick={() => onSave(list.filter((x) => /^\d{2}:\d{2}$/.test(x.at)).map(({ channel, ...x }) => (channel?.trim() ? { ...x, channel: channel.trim() } : x)))}>
            Save
          </Button>
        )}
      </div>
    </div>
  )
}

const NIGHT_DEFAULTS: NightShiftConfig = { enabled: false, mode: 'shadow', from: '22:00', to: '07:30', days: 'daily', followSlack: true, wake: [], dmAsMe: false }

// Night Shift: when it runs, what the bot may post by itself, and what wakes you.
function NightShiftRows({ value, changed, reset, save }: { value: Partial<NightShiftConfig> | undefined; changed: boolean; reset: () => void; save: (p: Partial<NightShiftConfig>) => void }) {
  const ns = { ...NIGHT_DEFAULTS, ...value }
  const field = 'rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  return (
    <>
      <Row
        label="Night Shift"
        hint="While you are away, mevo reads your mentions and DMs, sorts them (FYI, it can answer from your tickets and PRs, needs you, urgent) and drafts what its bot would say, always labelled as your assistant. Post factual answers: it posts the answers it can give from your work, and once per thread a “noted, you will see this when back” for what needs you. It never writes as you, approves, merges or promises dates. When you are back you get the morning handoff on Today and Telegram. Needs the bot's chat:write and your token's im:history, im:read, users:read, users.profile:read."
        changed={changed}
        onReset={reset}
      >
        <Select label="night shift mode" value={ns.mode} options={[{ value: 'shadow', label: 'Drafts only' }, { value: 'facts', label: 'Post factual answers' }]} onChange={(v) => save({ mode: v as NightShiftConfig['mode'] })} />
        <Toggle label="night shift" on={ns.enabled} onChange={(v) => save({ enabled: v })} />
      </Row>
      {ns.enabled && (
        <>
          <Row label="Away hours" hint="This computer's time. From after To crosses midnight. Outside them, your switch on Today still turns it on.">
            <input type="time" aria-label="from" value={ns.from} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && save({ from: e.target.value })} className={`${field} w-[7.5rem]`} />
            <span className="text-xs text-muted">to</span>
            <input type="time" aria-label="to" value={ns.to} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && save({ to: e.target.value })} className={`${field} w-[7.5rem]`} />
            <Select label="night shift days" value={ns.days} options={[{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }]} onChange={(v) => save({ days: v as NightShiftConfig['days'] })} />
          </Row>
          <Row label="Follow my Slack status" hint="Also on while Slack shows you away, or your status is 🌙, “night shift” or “ooo”.">
            <Toggle label="follow slack status" on={ns.followSlack} onChange={(v) => save({ followSlack: v })} />
          </Row>
          <Row label="Answer DMs from my account" hint="A DM is answered in that same conversation, from your account, always starting with “This is mevo, your assistant, writing from your account: you are on Night Shift”. In Post factual answers mode it answers questions about your work and, once per person, says the rest waits for you. Off: the bot answers them in their own DM with the bot.">
            <Toggle label="answer DMs from my account" on={ns.dmAsMe} onChange={(v) => save({ dmAsMe: v })} />
          </Row>
          <Row label="Wake me for" hint="Messages with these words or names are urgent and reach you on Telegram right away, whatever the model thinks. Comma separated.">
            <TextField label="wake words" value={ns.wake.join(', ')} placeholder="prod, down, dom" onSave={(v) => save({ wake: v.split(',').map((w) => w.trim()).filter(Boolean).slice(0, 20) })} />
          </Row>
        </>
      )}
    </>
  )
}
