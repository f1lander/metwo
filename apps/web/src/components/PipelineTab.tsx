import type { Effort, Health, PipelineStage, PipelineStageId, PipelineView, PrinciplesUpdate, SettingsView, StepId, Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useEffect, useState } from 'react'
import { controls, loadPipeline } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { has, NumberField, Panel, type Reset, Row, type Run, type Save, Segmented, Select, Toggle } from './settings-ui.js'
import { modelName } from './status.js'
import { StepTuning } from './StepTuning.js'
import { Button, Count, Mono, rise, timeAgo } from './ui.js'

const NUMBER: Record<PipelineStageId, number> = { intake: 1, implement: 2, review: 3, beforePr: 4, pr: 5, followUps: 6 }

// Settings in the order a ticket goes through them, with a map of the whole flow on top.
export function PipelineTab({ health, view, busy, run, save, reset, tickets }: { health: Health; view: SettingsView; busy: string | null; run: Run; save: Save; reset: Reset; tickets: readonly Ticket[] }) {
  const [map, setMap] = useState<PipelineView | null>(null)
  useEffect(() => {
    loadPipeline().then(setMap, () => setMap(null))
  }, [view])
  const stage = (id: PipelineStageId) => map?.stages.find((s) => s.id === id)
  const e = view.effective
  const o = view.overrides
  const others = (['codex', 'cursor', 'opencode', 'hermes'] as const).filter((id) => e.engines[id].enabled).map((id) => ({ value: id, label: `${id}${e.engines[id].model ? ` · ${e.engines[id].model}` : ''}` }))
  // engine, or engine:model: the same choice for every step
  const engineOptions = [{ value: 'claude', label: 'Claude · model from the config' }, { value: 'claude:opus', label: 'Claude Opus' }, { value: 'claude:sonnet', label: 'Claude Sonnet' }, { value: 'claude:haiku', label: 'Claude Haiku' }, ...others]
  const tuning = (step: StepId) => <StepTuning step={step} view={view} save={save} reset={reset} tickets={tickets} />
  const title = (id: PipelineStageId, fallback: string) => (
    <span className="flex items-center gap-2">
      <span className="flex size-5 items-center justify-center rounded-full bg-raised text-[10px] tabular-nums text-muted">{NUMBER[id]}</span>
      {stage(id)?.title ?? fallback}
    </span>
  )
  // what only the config file sets, shown so the stage reads complete
  const fileRows = (id: PipelineStageId) =>
    stage(id)
      ?.steps.filter((s) => !s.setting)
      .map((s) => (
        <Row key={s.key} label={s.label} hint={<span>in the config file: <Mono>stages.{s.key}</Mono></span>}>
          <Mono className={s.on ? 'text-fg-2' : 'text-dim'}>{s.value}</Mono>
        </Row>
      ))

  return (
    <>
      <PipelineMap map={map} />

      <Panel id="stage-intake" title={title('intake', 'Intake')} hint={stage('intake')?.what}>
        <Row label="Autopilot" hint={e.autopilot.enabled ? `${health.lanes.autopilot?.today ?? 0} of ${e.autopilot.maxPerDay} taken today. Small tickets (quick UI fixes, low-risk labels, estimate 2 or less) start by themselves; anything bigger or labelled Security / High / Protocol still asks you.` : 'off: every ticket asks you first'} changed={has(o.autopilot, 'enabled')} onReset={() => reset('autopilot.enabled')}>
          <Toggle label="autopilot" on={e.autopilot.enabled} onChange={(v) => save({ autopilot: { enabled: v } })} />
        </Row>
        <Row label="Tickets per day" hint="After this many, new small tickets wait for you." changed={has(o.autopilot, 'maxPerDay')} onReset={() => reset('autopilot.maxPerDay')}>
          <NumberField label="tickets per day" value={e.autopilot.maxPerDay} min={1} onSave={(v) => v && save({ autopilot: { maxPerDay: Math.round(v) } })} />
        </Row>
        <Row label="Check readiness before starting" hint="A cheap model reads each new ticket and its Linear discussion: ready, needs clarification or hold. Your own starts just get a warning." changed={has(o.readiness, 'auto')} onReset={() => reset('readiness.auto')}>
          <Toggle label="readiness check" on={e.readiness.auto} onChange={(v) => save({ readiness: { auto: v } })} />
        </Row>
        <Row label="Readiness engine" hint="Auto: OpenCode with its model when it is enabled (free models work), otherwise Claude Haiku. It gets no tools, only the ticket text." changed={has(o.readiness, 'engine')} onReset={() => reset('readiness.engine')}>
          <Select label="readiness engine" value={e.readiness.engine} options={[{ value: 'auto', label: 'Auto' }, { value: 'opencode', label: 'OpenCode' }, { value: 'claude:haiku', label: 'Claude Haiku' }, { value: 'claude:sonnet', label: 'Claude Sonnet' }, { value: 'off', label: 'Off' }]} onChange={(v) => save({ readiness: { engine: v } })} />
        </Row>
        <Row label="Autopilot needs" hint="Confidence the readiness check must reach before autopilot starts a ticket." changed={has(o.readiness, 'minConfidence')} onReset={() => reset('readiness.minConfidence')}>
          <NumberField label="minimum confidence" value={e.readiness.minConfidence} min={0} onSave={(v) => v !== null && save({ readiness: { minConfidence: Math.max(0, Math.min(100, Math.round(v))) } })} />
        </Row>
        <Row label="Triage the cycle by itself" hint="AI sizes new and edited cycle issues a few times a day. Off: only when you press Triage. Each run counts in the budget." changed={has(o, 'triage')} onReset={() => reset('triage')}>
          <Toggle label="auto triage" on={e.triage?.auto ?? false} onChange={(v) => save({ triage: { auto: v } })} />
        </Row>
        {fileRows('intake')}
      </Panel>

      <Panel id="stage-implement" title={title('implement', 'Implement')} hint={`${stage('implement')?.what ?? ''} ${health.lanes.active.length} of ${health.lanes.max} running${health.lanes.active.length ? `: ${health.lanes.active.join(', ')}` : ''}${health.lanes.paused ? ' · paused' : ''}.`}>
        <Row label="Implementer · lite" hint="Small tickets." changed={has(o.roles?.implementer, 'lite')} onReset={() => reset('roles.implementer.lite')}>
          <Select label="lite implementer" value={e.roles.implementer.lite} options={engineOptions} onChange={(v) => save({ roles: { implementer: { lite: v } } })} />
        </Row>
        <Row label="Implementer · full" hint="Bugs, security, high priority and anything big." changed={has(o.roles?.implementer, 'full')} onReset={() => reset('roles.implementer.full')}>
          <Select label="full implementer" value={e.roles.implementer.full} options={engineOptions} onChange={(v) => save({ roles: { implementer: { full: v } } })} />
        </Row>
        {health.lanes.models && (
          <Row label="Claude models" hint={<span>in the config file: <Mono>stages.implement.models</Mono>, <Mono>stages.review.model</Mono></span>}>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
              {(['lite', 'full', 'review'] as const).map((k) => (
                <Fragment key={k}>
                  <span className="text-fg-2">{k}</span>
                  <span className="whitespace-nowrap">{modelName(health.lanes.models?.[k].model)}</span>
                </Fragment>
              ))}
            </div>
          </Row>
        )}
        <Row label="Effort" hint="How hard every lane and review thinks. Max stays a per-ticket choice (Start max). The budget can lower it." changed={has(o, 'effort')} onReset={() => reset('effort')}>
          <Segmented<Effort> label="effort" value={e.pipeline.effort} options={['low', 'medium', 'high']} onChange={(x) => void run('effort', () => controls.effort(x))()} />
        </Row>
        <Row label="Lanes at once" hint="Each one can run a dev server, Storybook and a browser." changed={has(o, 'maxParallel')} onReset={() => reset('maxParallel')}>
          <div className="flex items-center overflow-hidden rounded-md border border-line-2">
            <button type="button" aria-label="fewer lanes" className="px-2.5 py-1 text-muted hover:bg-raised hover:text-fg disabled:opacity-40" disabled={busy !== null || health.lanes.max <= 1} onClick={run('parallel', () => controls.parallel(health.lanes.max - 1))}>
              −
            </button>
            <span className="w-7 text-center text-xs font-medium tabular-nums">
              <Count value={health.lanes.max} />
            </span>
            <button type="button" aria-label="more lanes" className="px-2.5 py-1 text-muted hover:bg-raised hover:text-fg disabled:opacity-40" disabled={busy !== null || health.lanes.max >= 8} onClick={run('parallel', () => controls.parallel(health.lanes.max + 1))}>
              +
            </button>
          </div>
        </Row>
        <Row label="Queue" hint={health.lanes.paused ? 'paused: running lanes finish, nothing new starts' : 'accepting work'}>
          {health.lanes.paused ? (
            <Button variant="primary" disabled={busy !== null} onClick={run('resume', () => controls.resume())}>
              Resume
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={run('pause', () => controls.pause())}>
              Pause
            </Button>
          )}
        </Row>
        <Row label="Aim for" hint="Lines the lane aims for (about 200 is the sweet spot). Bigger work: it does the first slice that stands on its own and lists the rest as follow-ups. Empty: no target." changed={has(o.quality, 'targetLines')} onReset={() => reset('quality.targetLines')}>
          <NumberField label="target lines" placeholder="no limit" min={20} value={e.quality.targetLines} onSave={(n) => save({ quality: { targetLines: n === null ? null : Math.round(n) } })} />
        </Row>
        {fileRows('implement')}
        {tuning('implement')}
      </Panel>
      <Principles health={health} view={view} save={save} reset={reset} />

      <Panel id="stage-review" title={title('review', 'Review & gates')} hint={stage('review')?.what}>
        <Row label="Review pass" hint="A second read of the finished work, with the style guide and principles as lenses. The budget skips it for lite tickets when it is saving." changed={has(o.pipeline, 'reviewPass')} onReset={() => reset('pipeline.reviewPass')}>
          <Toggle label="review pass" on={e.pipeline.reviewPass} onChange={(v) => save({ pipeline: { reviewPass: v } })} />
        </Row>
        <Row label="Reviewer" hint="The review pass, and the PRs you review." changed={has(o.roles, 'reviewer')} onReset={() => reset('roles.reviewer')}>
          <Select label="reviewer" value={e.roles.reviewer} options={engineOptions} onChange={(v) => save({ roles: { reviewer: v } })} />
        </Row>
        <Row label="Security lens" hint="When the diff adds signing, transactions, approvals, auth, storage or raw HTML, the review pass also reads it like a bug bounty researcher." changed={has(o.quality, 'securityLens')} onReset={() => reset('quality.securityLens')}>
          <Toggle label="security lens" on={e.quality.securityLens} onChange={(v) => save({ quality: { securityLens: v } })} />
        </Row>
        {tuning('review')}
        {fileRows('review')}
        <Row label="Supervisor" hint="After mevo re-runs the gates, checks the work against the ticket and asks for proofs. Opposite: another vendor than the implementer." changed={has(o.roles, 'supervisor')} onReset={() => reset('roles.supervisor')}>
          <Select label="supervisor" value={e.roles.supervisor} options={[{ value: 'opposite', label: 'opposite vendor' }, { value: 'off', label: 'off' }, ...engineOptions]} onChange={(v) => save({ roles: { supervisor: v } })} />
        </Row>
        <Row label="Supervisor rounds" hint="How many times concerns go back to the implementer." changed={has(o.roles, 'supervisorRounds')} onReset={() => reset('roles.supervisorRounds')}>
          <NumberField label="supervisor rounds" value={e.roles.supervisorRounds} onSave={(v) => v !== null && save({ roles: { supervisorRounds: Math.round(v) } })} />
        </Row>
        {tuning('supervisor')}
        <Row label="Visual check" hint="The Run visual check button, in a browser against the design." changed={has(o.roles, 'visual')} onReset={() => reset('roles.visual')}>
          <Select label="visual check" value={e.roles.visual} options={engineOptions} onChange={(v) => save({ roles: { visual: v } })} />
        </Row>
        {tuning('visual')}
        <Row label="Who takes the screenshots" hint="Lane: the lane drives the browser and shoots while it works. Steps: the lane writes the test as steps (VISUAL-PLAN.json); mevo runs them with the test wallet, takes the shots and records the video, and the lane fixes what failed and judges the shots. The same steps start the hand test." changed={has(o.shots, 'mode')} onReset={() => reset('shots.mode')}>
          <Segmented label="who takes the screenshots" value={e.shots.mode} options={['lane', 'steps'] as const} onChange={(v) => save({ shots: { mode: v } })} />
        </Row>
        <Row label="Screenshots at most" hint="Stories and before shots included. The lane plans them from the acceptance criteria, and only the ones VISUAL.json names reach the PR, in that order." changed={has(o.shots, 'max')} onReset={() => reset('shots.max')}>
          <NumberField label="screenshots at most" min={1} value={e.shots.max} onSave={(n) => n !== null && save({ shots: { max: Math.min(40, Math.round(n)) } })} />
        </Row>
        <Row label="Mobile shots" hint="Layout: 390x844 only for states whose layout changes." changed={has(o.shots, 'mobile')} onReset={() => reset('shots.mobile')}>
          <Segmented label="mobile shots" value={e.shots.mobile} options={['layout', 'always', 'never'] as const} onChange={(v) => save({ shots: { mobile: v } })} />
        </Row>
        <Row label="Before shots" hint="Changed: only for states whose look changed (a fixed bug, a restyle). New screens have no before." changed={has(o.shots, 'before')} onReset={() => reset('shots.before')}>
          <Segmented label="before shots" value={e.shots.before} options={['changed', 'bugs', 'never'] as const} onChange={(v) => save({ shots: { before: v } })} />
        </Row>
        <Row label="Video" hint="Interactions: one clip, planned as steps and sped up 1.5x, only when a screenshot can't show the change (a flow, an animation, focus). One video reaches the PR." changed={has(o.shots, 'video')} onReset={() => reset('shots.video')}>
          <Segmented label="video" value={e.shots.video} options={['interactions', 'off'] as const} onChange={(v) => save({ shots: { video: v } })} />
        </Row>
        <Row label="Story shots at most" hint="Only for states no route in the app reaches. The PR lists the changed stories either way." changed={has(o.shots, 'stories')} onReset={() => reset('shots.stories')}>
          <NumberField label="story shots at most" min={0} value={e.shots.stories} onSave={(n) => n !== null && save({ shots: { stories: Math.min(20, Math.round(n)) } })} />
        </Row>
      </Panel>

      <Panel id="stage-beforePr" title={title('beforePr', 'Before the PR')} hint={stage('beforePr')?.what}>
        <Row label="Local checks" hint="Typecheck, lint and tests (reused when the supervisor just ran them green), then e2e. Runs when a lane finishes and before any push." changed={has(o.localChecks, 'enabled')} onReset={() => reset('localChecks.enabled')}>
          <Toggle label="local checks" on={e.localChecks.enabled} onChange={(v) => save({ localChecks: { enabled: v } })} />
        </Row>
        <Row label="e2e specs" hint="Related: only the specs for the feature the change touches. All: every spec CI would run for that app, about an hour. One e2e run at a time; they share the local chain." changed={has(o.localChecks, 'e2e')} onReset={() => reset('localChecks.e2e')}>
          <Segmented label="e2e specs" value={e.localChecks.e2e} options={['related', 'all', 'off'] as const} onChange={(v) => save({ localChecks: { e2e: v } })} />
        </Row>
        <Row label="e2e once the PR is open" hint="Off: after the PR exists, GitHub's CI runs them on every push and pushes here skip them (Run again still runs them). On: every push runs them here too." changed={has(o.localChecks, 'e2eAfterPr')} onReset={() => reset('localChecks.e2eAfterPr')}>
          <Toggle label="e2e after PR" on={e.localChecks.e2eAfterPr} onChange={(v) => save({ localChecks: { e2eAfterPr: v } })} />
        </Row>
        <Row label="Most" hint="Lines. Over it the PR is not marked ready for review (you can still do it anyway) and autopilot stops before the PR. Lockfiles and snapshots are not counted. Empty: no limit." changed={has(o.quality, 'maxLines')} onReset={() => reset('quality.maxLines')}>
          <NumberField label="max lines" placeholder="no limit" min={20} value={e.quality.maxLines} onSave={(n) => save({ quality: { maxLines: n === null ? null : Math.round(n) } })} />
        </Row>
        {fileRows('beforePr')}
      </Panel>

      <Panel id="stage-pr" title={title('pr', 'PR')} hint={stage('pr')?.what}>
        <Row label="Open the draft PR when a lane finishes" hint="The first time a lane finishes and there is no PR yet, push and open it as a draft. Off: it waits for your push." changed={has(o.pipeline, 'draftOnFinish')} onReset={() => reset('pipeline.draftOnFinish')}>
          <Toggle label="draft on finish" on={e.pipeline.draftOnFinish} onChange={(v) => save({ pipeline: { draftOnFinish: v } })} />
        </Row>
        <Row label="Autopilot opens it too" hint="For autopilot tickets, only when the gates pass, the supervisor says pass and the visual check is verified. Otherwise it waits and tells you why." changed={has(o.autopilot, 'autoPush')} onReset={() => reset('autopilot.autoPush')}>
          <Toggle label="auto draft PR" on={e.autopilot.autoPush} onChange={(v) => save({ autopilot: { autoPush: v } })} />
        </Row>
        <Row label="Screenshots and videos" hint="Browser: GitHub's own uploader from mevo's signed-in profile (gist as backup; needs a restart to switch to it). Gist: a secret gist. None: not attached." changed={has(o.github, 'screenshots')} onReset={() => reset('github.screenshots')}>
          <Segmented label="screenshots" value={e.github.screenshots} options={['browser', 'gist', 'none'] as const} onChange={(v) => save({ github: { screenshots: v } })} />
        </Row>
        <Row label="Greptile" hint="Asked to review after the draft opens and after every push that follows its review. Its findings come back as Quick fix or a lane." changed={has(o.github?.greptile, 'enabled')} onReset={() => reset('github.greptile.enabled')}>
          <Toggle label="greptile" on={e.github.greptile.enabled} onChange={(v) => save({ github: { greptile: { enabled: v } } })} />
        </Row>
        <Row label="Greptile at least" hint="Score out of 5 a PR needs before it is marked ready for review. No score yet does not hold it." changed={has(o.quality, 'minGreptile')} onReset={() => reset('quality.minGreptile')}>
          <NumberField label="minimum Greptile score" placeholder="none" min={1} value={e.quality.minGreptile} onSave={(n) => save({ quality: { minGreptile: n === null ? null : Math.min(5, Math.round(n)) } })} />
        </Row>
        <Row label="Request reviewers" hint={`On Ready for review, GitHub's suggested reviewers, up to ${e.github.reviewers.max}.`} changed={has(o.github?.reviewers, 'auto')} onReset={() => reset('github.reviewers.auto')}>
          <Toggle label="request reviewers" on={e.github.reviewers.auto} onChange={(v) => save({ github: { reviewers: { auto: v } } })} />
        </Row>
        {fileRows('pr')}
      </Panel>

      <Panel id="stage-followUps" title={title('followUps', 'Follow-ups')} hint={stage('followUps')?.what}>
        <Row label="Quick fix engine" hint="Small follow-ups you check by hand: a fresh session, low effort by default, no e2e." changed={has(o.quality, 'quick')} onReset={() => reset('quality.quick')}>
          <Select label="quick fix engine" value={e.quality.quick} options={engineOptions.filter((x) => x.value !== 'claude')} onChange={(v) => save({ quality: { quick: v } })} />
        </Row>
        {tuning('quick')}
        <Row label="Reply in the threads" hint={'After a push that answers review comments: "Addressed in <commit>" in each thread you dealt with, unless you already answered it.'} changed={has(o.afterFix, 'reply')} onReset={() => reset('afterFix.reply')}>
          <Toggle label="reply in threads" on={e.afterFix.reply} onChange={(v) => save({ afterFix: { reply: v } })} />
        </Row>
        <Row label="Resolve the threads" hint="Off by default: many reviewers like to resolve their own threads after checking." changed={has(o.afterFix, 'resolve')} onReset={() => reset('afterFix.resolve')}>
          <Toggle label="resolve threads" on={e.afterFix.resolve} onChange={(v) => save({ afterFix: { resolve: v } })} />
        </Row>
        <Row label="Ask for a re-review" hint="Once every thread from a reviewer who requested changes is answered, re-request their review." changed={has(o.afterFix, 'rerequest')} onReset={() => reset('afterFix.rerequest')}>
          <Toggle label="re-request review" on={e.afterFix.rerequest} onChange={(v) => save({ afterFix: { rerequest: v } })} />
        </Row>
        <Row label="Update from main by itself" hint="Merge the base into open draft PRs that are behind and conflict free, then push if the gates pass. Off: the Update from main button." changed={has(o.pipeline, 'autoUpdateFromMain')} onReset={() => reset('pipeline.autoUpdateFromMain')}>
          <Toggle label="update from main" on={e.pipeline.autoUpdateFromMain} onChange={(v) => save({ pipeline: { autoUpdateFromMain: v } })} />
        </Row>
        <Row label="Pull commits made on GitHub" hint="GitHub's Update branch button or a teammate's commit come into the worktree by themselves when it is a fast-forward. Anything else waits for Pull from GitHub." changed={has(o.pipeline, 'autoPullPr')} onReset={() => reset('pipeline.autoPullPr')}>
          <Toggle label="pull from GitHub" on={e.pipeline.autoPullPr} onChange={(v) => save({ pipeline: { autoPullPr: v } })} />
        </Row>
        {fileRows('followUps')}
      </Panel>

      <p className="px-1 text-[11px] leading-relaxed text-dim">
        Changes here are saved in data/state.json and win over ticketflow.config.json. {map?.staged ? 'Your config file uses the stages block.' : 'The config file can describe the same stages in a "stages" block.'} See docs/pipeline.md.
      </p>
    </>
  )
}

// The flow at a glance: each stage with what is on. A click jumps to its settings.
function PipelineMap({ map }: { map: PipelineView | null }) {
  if (!map) return null
  return (
    <motion.section variants={rise} aria-label="pipeline" className="grid grid-cols-6 gap-1.5 max-lg:grid-cols-3 max-sm:grid-cols-2">
      {map.stages.map((s, i) => (
        <StageCard key={s.id} stage={s} last={i === map.stages.length - 1} />
      ))}
    </motion.section>
  )
}

function StageCard({ stage, last }: { stage: PipelineStage; last: boolean }) {
  const shown = stage.steps.filter((s) => s.setting || s.on).slice(0, 5)
  return (
    <a
      href={`#stage-${stage.id}`}
      onClick={(ev) => {
        ev.preventDefault()
        document.getElementById(`stage-${stage.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}
      className="group relative flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-2 hover:border-line-2"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-fg">
        <span className="tabular-nums text-dim">{NUMBER[stage.id]}</span>
        {stage.title}
      </span>
      <ul className="flex flex-col gap-0.5">
        {shown.map((s) => (
          <li key={s.key} title={`${s.label}: ${s.value}`} className={`flex items-center gap-1.5 truncate text-[10px] ${s.on ? 'text-fg-2' : 'text-dim'}`}>
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${s.on ? 'bg-ok' : 'bg-line-2'}`} />
            <span className="truncate">{s.label}</span>
          </li>
        ))}
      </ul>
      {!last && (
        <span aria-hidden="true" className="absolute top-1/2 -right-[9px] z-10 -translate-y-1/2 text-[10px] text-dim max-lg:hidden">
          ›
        </span>
      )}
    </a>
  )
}

const PHASE_LABEL = { implement: 'Every lane', bug: 'Bug playbook', feature: 'Feature playbook', refactor: 'Refactor playbook', perf: 'Perf playbook', visual: 'Visual playbook', review: 'Review lenses', prose: 'Prose' } as const

// pstack, pinned to one commit. A newer commit only comes in after you read its diff and accept it.
function Principles({ health, view, save, reset }: { health: Health; view: SettingsView; save: Save; reset: Reset }) {
  const p = health.lanes.principles
  const on = view.effective.principles?.enabled ?? false
  const [update, setUpdate] = useState<PrinciplesUpdate | null>(null)
  const [checking, setChecking] = useState(false)
  if (!p) return null
  const web = p.repo.startsWith('https://github.com/') ? p.repo.replace(/\.git$/, '') : null
  const check = async () => {
    setChecking(true)
    try {
      const u = await controls.principlesUpdate()
      setUpdate(u)
      if (u.latest === u.current) notice({ title: 'pstack is up to date', tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setChecking(false)
    }
  }
  const state = !on ? 'off' : p.error ? p.error : p.head === p.ref ? `on disk${p.syncedAt ? `, checked ${timeAgo(p.syncedAt)}` : ''}` : 'fetching…'
  return (
    <Panel
      title="Engineering principles"
      hint={
        <>
          {web ? (
            <a href={web} target="_blank" rel="noreferrer" className="text-fg-2 underline decoration-line-2 underline-offset-2 hover:text-fg">
              pstack
            </a>
          ) : (
            'pstack'
          )}{' '}
          (MIT). Lanes read these files before they code and follow a playbook picked from the ticket (bug, feature, refactor, perf or visual match), the review pass and PR reviews apply them as lenses, and the supervisor checks the diff against them. Only the markdown is used; their steps that spawn agents, push or open PRs are ignored.
        </>
      }
    >
      <Row label="Use them on every ticket" hint="Each ticket can still turn them off or on for itself, from its Overview." changed={has(view.overrides.principles, 'enabled')} onReset={() => reset('principles.enabled')}>
        <Toggle label="engineering principles" on={on} onChange={(v) => save({ principles: { enabled: v } })} />
      </Row>
      <Row label="Pinned commit" hint={<span className={on && p.error ? 'text-bad' : ''}>{state}. Nothing changes until you accept a newer commit.</span>} changed={has(view.overrides.principles, 'ref')} onReset={() => reset('principles.ref')}>
        {web ? (
          <a href={`${web}/commit/${p.ref}`} target="_blank" rel="noreferrer" className="hover:text-fg">
            <Mono className="text-fg-2">{p.ref.slice(0, 7)}</Mono>
          </a>
        ) : (
          <Mono className="text-fg-2">{p.ref.slice(0, 7)}</Mono>
        )}
        <Button disabled={!on || checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </Row>
      <AnimatePresence initial={false}>
        {update && update.latest !== update.current && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-xs text-fg-2">
                Newer commit <Mono>{update.latest.slice(0, 7)}</Mono>. Read what changed in the files mevo uses before you accept it: it becomes part of every lane's prompt.
              </p>
              {update.stat && <pre className="max-h-40 overflow-auto rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">{update.stat}</pre>}
              <details className="text-xs" open={update.diff.length < 4000}>
                <summary className="cursor-pointer text-muted">{update.diff ? 'Diff of the files mevo uses' : 'The files mevo uses did not change'}</summary>
                {update.diff && <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{update.diff}</pre>}
              </details>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    save({ principles: { ref: update.latest } })
                    setUpdate(null)
                  }}
                >
                  Accept {update.latest.slice(0, 7)}
                </Button>
                <Button onClick={() => setUpdate(null)}>Keep {update.current.slice(0, 7)}</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label="What each step reads">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          {(Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]).map((k) => (
            <Fragment key={k}>
              <span className="text-fg-2">{PHASE_LABEL[k]}</span>
              <span className="flex max-w-md flex-wrap gap-1">
                {(p.files[k] ?? []).map((f) => (
                  <span key={f.path} title={f.present ? f.path : `${f.path}: not in this commit`} className={`rounded bg-raised px-1.5 py-px font-mono ${f.present || !p.head ? 'text-muted' : 'text-dim line-through'}`}>
                    {f.path.replace(/^principle-/, '').replace(/\/SKILL\.md$|\.md$/, '')}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
        </div>
      </Row>
    </Panel>
  )
}
