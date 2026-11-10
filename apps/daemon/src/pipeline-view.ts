import type { PipelineStage, PipelineStep, PipelineView, StepId } from '@ticketflow/shared'
import type { Config } from './config.js'

const step = (label: string, value: string, on: boolean, key: string, setting = true): PipelineStep => ({ label, value, on, key, setting })
const engine = (ref: string) => (ref.includes(':') ? ref.replace(':', ' · ') : ref)
const cmd = (c: string) => c || 'not set'
// a step's own effort, what it leaves out and whether it has extra instructions
const tune = (cfg: Config, step: StepId) => {
  const t = cfg.steps[step]
  const offs = Object.entries(t.context).filter(([, on]) => on === false).length
  return [t.effort && step !== 'quick' ? `${t.effort} effort` : '', offs ? `${offs} context off` : '', t.instructions.trim() ? '+ instructions' : ''].filter(Boolean).map((x) => ` · ${x}`).join('')
}
const lines = (n: number | null) => (n === null ? 'no limit' : `${n} lines`)

// What each stage does with the values in effect now.
export function pipelineView(cfg: Config, staged: boolean): PipelineView {
  const stages: PipelineStage[] = [
    {
      id: 'intake',
      title: 'Intake',
      what: 'A Linear ticket shows up on the board, gets sized and checked, and starts by itself or waits for you.',
      steps: [
        step('Watched states', cfg.linear.watchStates.join(', '), true, 'intake.watch', false),
        step('Triage the cycle', cfg.triage.auto ? 'a few times a day' : 'when you press Triage', cfg.triage.auto, 'intake.triage.auto'),
        step('Readiness check', cfg.readiness.auto ? `${cfg.readiness.engine === 'auto' ? 'OpenCode or Claude Haiku' : engine(cfg.readiness.engine)}, autopilot needs ${cfg.readiness.minConfidence}%` : 'off', cfg.readiness.auto && cfg.readiness.engine !== 'off', 'intake.readiness'),
        step('Autopilot', cfg.autopilot.enabled ? `small tickets start by themselves, up to ${cfg.autopilot.maxPerDay} a day` : 'off: you start each ticket', cfg.autopilot.enabled, 'intake.autopilot'),
        step('Lane size', `full for ${cfg.classifier.fullLaneLabels.join(', ') || 'no labels'}; never auto for ${cfg.classifier.neverAuto.join(', ') || 'none'}`, true, 'intake.classifier', false),
      ],
    },
    {
      id: 'implement',
      title: 'Implement',
      what: 'A lane works in its own worktree from a brief: the ticket, Figma, docs and principles.',
      steps: [
        step('Implementer · lite', `${engine(cfg.roles.implementer.lite)}${cfg.roles.implementer.lite === 'claude' ? ` · ${cfg.models.lite.model}` : ''}${tune(cfg, 'implement')}`, true, 'implement.engine.lite'),
        step('Implementer · full', `${engine(cfg.roles.implementer.full)}${cfg.roles.implementer.full === 'claude' ? ` · ${cfg.models.full.model}` : ''}${tune(cfg, 'implement')}`, true, 'implement.engine.full'),
        step('Effort', cfg.pipeline.effort, true, 'implement.effort'),
        step('Lanes at once', String(cfg.pipeline.maxParallel), true, 'implement.maxParallel'),
        step('Aim for', lines(cfg.quality.targetLines), cfg.quality.targetLines !== null, 'implement.targetLines'),
        step('Engineering principles', cfg.principles.enabled ? `pstack @ ${cfg.principles.ref.slice(0, 7)}` : 'off', cfg.principles.enabled, 'implement.principles'),
        step('Docs', [cfg.wiki.path && 'wiki', cfg.knowledge.sources.length && `${cfg.knowledge.sources.length} knowledge source(s)`, cfg.knowledge.mcp.length && `MCP: ${cfg.knowledge.mcp.join(', ')}`].filter(Boolean).join(' · ') || 'none', Boolean(cfg.wiki.path || cfg.knowledge.sources.length || cfg.knowledge.mcp.length), 'implement.knowledge', false),
      ],
    },
    {
      id: 'review',
      title: 'Review & gates',
      what: 'Before you see it: a second read, the gates re-run by mevo, and a supervisor that checks the work against the ticket.',
      steps: [
        step('Review pass', cfg.pipeline.reviewPass ? `${engine(cfg.roles.reviewer)}${cfg.roles.reviewer === 'claude' ? ` · ${cfg.models.review.model}` : ''}${tune(cfg, 'review')}` : 'off', cfg.pipeline.reviewPass, 'review.pass'),
        step('Security lens', cfg.quality.securityLens ? 'when the diff touches signing, transactions, auth or HTML' : 'off', cfg.quality.securityLens, 'review.securityLens'),
        step('Gate · typecheck', cmd(cfg.repo.commands.typecheck), Boolean(cfg.repo.commands.typecheck), 'review.gates.typecheck', false),
        step('Gate · lint', cmd(cfg.repo.commands.lint), Boolean(cfg.repo.commands.lint), 'review.gates.lint', false),
        step('Gate · test', cmd(cfg.repo.commands.test), Boolean(cfg.repo.commands.test), 'review.gates.test', false),
        step('Supervisor', cfg.roles.supervisor === 'off' ? 'off' : `${cfg.roles.supervisor === 'opposite' ? 'another vendor than the implementer' : engine(cfg.roles.supervisor)}, up to ${cfg.roles.supervisorRounds} round(s)${tune(cfg, 'supervisor')}`, cfg.roles.supervisor !== 'off', 'review.supervisor'),
        step('Visual check', `${engine(cfg.roles.visual)}${tune(cfg, 'visual')}`, true, 'review.visual'),
      ],
    },
    {
      id: 'beforePr',
      title: 'Before the PR',
      what: 'What CI runs, run here first. A red result keeps the push back until it is fixed or you push anyway.',
      steps: [
        step('Local checks', cfg.localChecks.enabled ? 'gates, then e2e' : 'off', cfg.localChecks.enabled, 'beforePr.localChecks.enabled'),
        step('e2e specs', cfg.localChecks.e2e === 'off' ? 'off' : `${cfg.localChecks.e2e}, up to ${cfg.localChecks.e2eMinutes} min`, cfg.localChecks.enabled && cfg.localChecks.e2e !== 'off', 'beforePr.localChecks.e2e'),
        step('e2e once the PR is open', cfg.localChecks.e2eAfterPr ? 'here too' : "GitHub's CI only", cfg.localChecks.e2eAfterPr, 'beforePr.localChecks.e2eAfterPr'),
        step('Most', lines(cfg.quality.maxLines), cfg.quality.maxLines !== null, 'beforePr.maxLines'),
      ],
    },
    {
      id: 'pr',
      title: 'PR',
      what: 'The draft PR on GitHub, its media and reviewers. mevo never marks a PR ready by itself.',
      steps: [
        step('Draft PR when a lane finishes', cfg.pipeline.draftOnFinish ? 'the first time, by itself' : 'when you push', cfg.pipeline.draftOnFinish, 'pr.draftOnFinish'),
        step('Autopilot opens it', cfg.autopilot.autoPush ? 'when every check passes' : 'off', cfg.autopilot.enabled && cfg.autopilot.autoPush, 'intake.autopilot.autoPush'),
        step('Screenshots and videos', { browser: "GitHub's uploader", gist: 'secret gist', none: 'not attached' }[cfg.github.screenshots], cfg.github.screenshots !== 'none', 'pr.screenshots'),
        step('Greptile', cfg.github.greptile.enabled ? `asked on every push${cfg.quality.minGreptile ? `, ready needs ${cfg.quality.minGreptile}/5` : ''}` : 'off', cfg.github.greptile.enabled, 'pr.greptile'),
        step('Reviewers', cfg.github.reviewers.auto ? `GitHub's suggestions, up to ${cfg.github.reviewers.max}, on ready` : 'you pick them', cfg.github.reviewers.auto, 'pr.reviewers'),
      ],
    },
    {
      id: 'followUps',
      title: 'Follow-ups',
      what: 'Review comments, Greptile findings, main moving on, and commits made on GitHub.',
      steps: [
        step('Quick fixes', `${engine(cfg.quality.quick)}${cfg.steps.quick.effort && cfg.steps.quick.effort !== 'low' ? ` · ${cfg.steps.quick.effort} effort` : ''}${tune(cfg, 'quick')}`, true, 'followUps.quick'),
        step('After a fix', [cfg.afterFix.reply && 'reply', cfg.afterFix.resolve && 'resolve', cfg.afterFix.rerequest && 're-request review'].filter(Boolean).join(', ') || 'nothing on GitHub', cfg.afterFix.reply || cfg.afterFix.resolve || cfg.afterFix.rerequest, 'followUps.afterFix'),
        step('Update from main', cfg.pipeline.autoUpdateFromMain ? 'by itself when conflict free' : 'when you press it', cfg.pipeline.autoUpdateFromMain, 'followUps.autoUpdateFromMain'),
        step('Pull from GitHub', cfg.pipeline.autoPullPr ? 'fast-forwards by itself' : 'when you press it', cfg.pipeline.autoPullPr, 'followUps.autoPullPr'),
      ],
    },
  ]
  return { stages, staged }
}
