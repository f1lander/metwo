import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type BudgetStatus, type Effort, type StagePhase, type Lane, markdownSection, type MediaFile, openComments, type StartChoice, type SupervisionReport, type Ticket, type VisualReport } from '@ticketflow/shared'
import { regulatedEffort } from '../budget.js'
import { type Config, effective } from '../config.js'
import { enabledEngines, type Engine, type EngineId, parseEngineRef, type RunResult } from '../engines/index.js'
import { explainFailure } from '../failure.js'
import type { GithubBrowser } from '../github-browser.js'
import type { Learnings } from '../learnings.js'
import type { Linear } from '../linear.js'
import { log } from '../log.js'
import { formatComments } from '../pr-sync.js'
import type { Store } from '../store.js'
import { reviewPrompt, writeBrief } from './brief.js'
import { contextSection, gatherContext } from './context.js'
import { commentOnPr, existingPrUrl, ghLogin, livePrBody, markPrReady, previewDeploy, pushBranch, replyToReviewComment, requestSuggestedReviewers } from './github.js'
import { claudeCommand, openTerminal } from './open-claude.js'
import { PrPublisher } from './pr.js'
import { descPrompt, openChecks, readPatch } from './pr-desc.js'
import { commentsPrompt, greptilePrompt, instructPrompt, mergeConflictPrompt, mergeGatesPrompt, previewQaPrompt, resumePrompt, visualCheckPrompt } from './prompts.js'
import { writeResumeNote } from './resume-note.js'
import { git } from './shell.js'
import { fixPrompt, gatesFailed, readSupervision, runGates, supervisorPrompt } from './supervise.js'
import { readVisual } from './visual.js'
import { diffStat, ensureWorktree, hasUncommitted, localCommits, type Worktree } from './worktree.js'

export interface Notifier {
  readonly reviewReady: (ticket: Ticket) => Promise<void>
  readonly needsInput: (ticket: Ticket) => Promise<void>
  readonly prOpened: (ticket: Ticket) => Promise<void>
  readonly failed: (ticket: Ticket) => Promise<void>
  readonly noChange: (ticket: Ticket) => Promise<void>
  readonly greptileDeclined: (ticket: Ticket) => Promise<void>
  readonly uploads: (ok: boolean, detail: string) => void
  readonly visualDone: (ticket: Ticket) => Promise<void>
  readonly descReady: (ticket: Ticket) => Promise<void>
  readonly previewQaDone: (ticket: Ticket) => Promise<void>
  readonly claudeState: (ok: boolean, detail: string) => void
  readonly progress: (ticket: Ticket, kind: 'text' | 'tool' | 'stage', line: string) => void
}

class Stopped extends Error {
  constructor(id: string) {
    super(`${id} was stopped`)
  }
}

// Lifecycle: queued → running → (needs_input | review_ready) → pr_draft.
// One lane at a time per ticket; up to maxParallel tickets at once.
export class Runner {
  private readonly active = new Set<string>()
  // one per running ticket; aborting it kills the engine and whatever it started
  private readonly controllers = new Map<string, AbortController>()
  private readonly stopping = new Set<string>()
  // what each busy ticket is doing, so a stop knows how to resume it
  private readonly tasks = new Map<string, { task: 'lane' | 'visual'; from: Ticket['status'] }>()
  // last lines and the time of the last one, for "is it stuck?" and RESUME.md
  private readonly recent = new Map<string, { at: number; lines: string[] }>()
  browser: GithubBrowser | null = null
  learnings: Learnings | null = null
  // where spend stands; wired by the daemon (budget.ts)
  budget: () => BudgetStatus = () => ({ level: 'normal', regulate: false, day: { spent: 0, limit: null }, month: { spent: 0, limit: null }, fallback: null })

  private readonly pr: PrPublisher
  private memo: { settings: unknown; cfg: Config; engines: ReadonlyMap<EngineId, Engine> } | null = null

  constructor(
    private readonly base: Config,
    private readonly store: Store,
    private readonly linear: Linear,
    private readonly notify: Notifier,
  ) {
    this.pr = new PrPublisher(base, store, (id) => this.flowDir(id), notify, () => this.browser)
  }

  // The config with your Settings on top, rebuilt only when Settings change.
  get config(): Config {
    return this.current().cfg
  }

  private get cfg(): Config {
    return this.current().cfg
  }

  private get engines(): ReadonlyMap<EngineId, Engine> {
    return this.current().engines
  }

  private current(): { cfg: Config; engines: ReadonlyMap<EngineId, Engine> } {
    const settings = this.store.snapshot().settings
    if (!this.memo || this.memo.settings !== settings) {
      const cfg = effective(this.base, settings)
      this.memo = { settings, cfg, engines: enabledEngines(cfg) }
    }
    return this.memo
  }

  get engineList(): readonly Engine[] {
    return [...this.engines.values()]
  }

  // A role's engine and model. "opposite" = a different vendor than `implementer`; an engine
  // that is not enabled falls back to Claude; "off" (or nothing to oppose with) = null.
  resolve(ref: string, implementer: EngineId | null, claudeModel: string): { engine: Engine; model: string; ref: string } | null {
    if (!ref || ref === 'off') return null
    let id: EngineId
    let model = ''
    if (ref === 'opposite') {
      const order: EngineId[] = implementer === 'claude' ? ['codex', 'cursor', 'opencode', 'hermes'] : ['claude', 'codex', 'cursor', 'opencode', 'hermes']
      const pick = order.find((e) => e !== implementer && this.engines.has(e))
      if (!pick) return null
      id = pick
    } else {
      const parsed = parseEngineRef(ref)
      id = this.engines.has(parsed.engine) ? parsed.engine : 'claude'
      model = id === parsed.engine ? parsed.model : ''
    }
    const engine = this.engines.get(id) as Engine
    const fallback = id === 'claude' ? claudeModel : id === 'hermes' ? this.cfg.engines.hermes.model : this.cfg.engines[id].model
    return { engine, model: model || fallback, ref: `${id}${model || fallback ? `:${model || fallback}` : ''}` }
  }

  // persisted, so a paused metwo stays paused across restarts
  get paused(): boolean {
    return this.store.snapshot().settings?.paused ?? false
  }

  set paused(value: boolean) {
    this.store.setSettings({ paused: value })
  }

  // Starts queued tickets while slots are free and returns right away; lanes run in the
  // background so callers (Telegram handlers, HTTP) never wait on a whole lane.
  pump(): void {
    if (this.paused) return
    const free = this.maxParallel - this.active.size
    if (free <= 0) return
    for (const t of this.store.byStatus('queued').slice(0, free)) void this.run(t.id)
  }

  get maxParallel(): number {
    return this.cfg.pipeline.maxParallel
  }

  get effort(): Effort {
    return this.cfg.pipeline.effort
  }

  setEffort(effort: Effort): void {
    this.store.setSettings({ effort })
  }

  setMaxParallel(n: number): number {
    const clamped = Math.max(1, Math.min(8, Math.round(n)))
    this.store.setSettings({ maxParallel: clamped })
    this.pump()
    return clamped
  }

  // `engine` overrides the lane's implementer for this ticket ("codex", "cursor:gpt-5"...).
  enqueue(id: string, choice: StartChoice, engine?: string): void {
    const lane: Lane = choice === 'max' ? 'full' : choice
    const maxEffort = choice === 'max'
    const t = this.store.get(id)
    const base = t ? (({ engine: _e, ...rest }) => rest)(t) : undefined
    if (base) this.store.upsert(engine ? { ...base, engine } : base)
    this.store.patch(id, { status: 'queued', lane, maxEffort }, { kind: 'decision', message: `queued for ${choice === 'max' ? 'full lane at max effort' : `${lane} lane`}${engine ? ` on ${engine}` : ''}` })
  }

  laneLog(id: string): string {
    return path.join(this.flowDir(id), 'logs', 'lane.jsonl')
  }

  get activeIds(): readonly string[] {
    return [...this.active]
  }

  // When the lane last said anything, and what.
  activity(id: string): { at: number; line: string } | null {
    const r = this.recent.get(id)
    return r ? { at: r.at, line: r.lines.at(-1) ?? '' } : null
  }

  private progress(ticket: Ticket, kind: 'text' | 'tool' | 'stage', line: string): void {
    if (kind === 'stage') this.store.patch(ticket.id, { stage: { name: line, phase: phaseOf(line), at: new Date().toISOString() } })
    const r = this.recent.get(ticket.id) ?? { at: 0, lines: [] }
    r.at = Date.now()
    r.lines.push(`${new Date().toISOString().slice(11, 16)} ${line.split('\n')[0]?.slice(0, 200) ?? ''}`)
    if (r.lines.length > 20) r.lines.splice(0, r.lines.length - 20)
    this.recent.set(ticket.id, r)
    this.notify.progress(ticket, kind, line)
  }

  // Marks the ticket busy and gives it an abort signal for everything it runs.
  private begin(id: string): AbortSignal {
    this.active.add(id)
    const c = new AbortController()
    this.controllers.set(id, c)
    this.recent.set(id, { at: Date.now(), lines: this.recent.get(id)?.lines ?? [] })
    return c.signal
  }

  private end(id: string): void {
    this.active.delete(id)
    this.controllers.delete(id)
    this.tasks.delete(id)
    // an instruction you sent while it ran goes now, as a follow-up on the same session
    const t = this.store.get(id)
    const q = t?.queuedInstruction
    if (q && (t.status === 'review_ready' || t.status === 'no_change' || t.status === 'pr_draft')) {
      this.store.patch(id, { queuedInstruction: null })
      setTimeout(() => {
        this.sendInstruction(id, q.text, q.images).catch((e: unknown) => log.warn(`${id}: queued instruction failed`, e))
      }, 0)
    }
  }

  private signalOf(id: string): AbortSignal | undefined {
    return this.controllers.get(id)?.signal
  }

  private checkStopped(id: string): void {
    if (this.signalOf(id)?.aborted) throw new Stopped(id)
  }

  private async fail(id: string, error: unknown): Promise<void> {
    if (error instanceof Stopped || this.stopping.has(id)) return
    const message = error instanceof Error ? error.message : String(error)
    const failure = explainFailure(message, this.laneLog(id))
    log.error(`${id}: ${failure.title} · ${message}`)
    if (failure.code.startsWith('claude_')) this.notify.claudeState(false, failure.title)
    const failed = this.store.patch(id, { status: 'failed', error: message, failure }, { kind: 'error', message: `${failure.title}: ${message}` })
    this.store.journal(id, { kind: 'failure', title: failure.title, body: `${failure.detail}\n\n→ ${failure.hint}` })
    this.progress(failed, 'stage', `failed · ${failure.title}`)
    await this.notify.failed(failed)
  }

  // Kills the lane (and its dev servers and browser), writes RESUME.md next to the brief and
  // parks the ticket as stopped. Resume picks the same session back up.
  async stop(id: string, reason = 'stopped by you'): Promise<Ticket> {
    const ticket = this.store.get(id)
    if (!ticket) throw new Error(`unknown ticket ${id}`)
    if (ticket.status === 'queued' && !this.active.has(id)) {
      return this.store.patch(id, { status: 'stopped', stopped: { task: 'queued', from: 'assigned', at: new Date().toISOString(), reason } }, { kind: 'stop', message: `${reason} before it started` })
    }
    if (!this.active.has(id)) throw new Error(`${id} is not running`)
    const task = this.tasks.get(id) ?? { task: 'lane' as const, from: 'running' as const }
    this.stopping.add(id)
    try {
      this.controllers.get(id)?.abort()
      const deadline = Date.now() + 20_000
      while (this.active.has(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
      return this.park(id, task, reason)
    } finally {
      this.stopping.delete(id)
    }
  }

  // Pause after this step: the lane finishes what it is doing and stops before the next one.
  setPauseAfter(id: string, on: boolean): Ticket {
    const t = this.store.get(id)
    if (!t) throw new Error(`unknown ticket ${id}`)
    return this.store.patch(id, { pauseAfter: on }, on ? { kind: 'stop', message: 'will pause after this step' } : undefined)
  }

  private pausePoint(id: string, next: string): void {
    if (!this.store.get(id)?.pauseAfter) return
    this.store.patch(id, { pauseAfter: false })
    this.park(id, this.tasks.get(id) ?? { task: 'lane', from: 'running' }, `paused by you before ${next}`)
    throw new Stopped(id)
  }

  // Every running lane, at once. Queued tickets stay queued; `pause` keeps them from starting.
  async stopAll(reason: string, pause: boolean): Promise<readonly string[]> {
    if (pause) this.paused = true
    const ids = [...this.active]
    await Promise.all(ids.map((id) => this.stop(id, reason).catch((e: unknown) => log.warn(`${id}: stop failed`, e))))
    return ids
  }

  // For a daemon that is going down right now: kill everything and write what it can, synchronously.
  shutdown(reason: string): readonly string[] {
    const ids = [...this.active]
    for (const id of ids) {
      this.stopping.add(id)
      this.controllers.get(id)?.abort()
      this.park(id, this.tasks.get(id) ?? { task: 'lane', from: 'running' }, reason)
    }
    return ids
  }

  // A ticket that was mid-run when the daemon died has no process left; just park it.
  recover(id: string): void {
    this.park(id, { task: 'lane', from: 'running' }, 'the daemon stopped while it ran')
  }

  private park(id: string, task: { task: 'lane' | 'visual'; from: Ticket['status'] }, reason: string): Ticket {
    const note = this.writeResume(id, reason)
    const at = new Date().toISOString()
    const parked = this.store.patch(id, { status: 'stopped', stopped: { task: task.task, from: task.from, at, reason } }, { kind: 'stop', message: reason })
    this.store.journal(id, { kind: 'note', title: `Stopped · ${reason}`, body: note })
    return parked
  }

  private writeResume(id: string, reason: string): string {
    const ticket = this.store.get(id)
    return ticket ? writeResumeNote(ticket, this.flowDir(id), this.cfg.repo.baseBranch, this.recent.get(id)?.lines ?? [], reason) : ''
  }

  // Picks a stopped ticket back up where it was: the same session for a lane, a fresh visual
  // check, or back in the queue if it never started.
  async resume(id: string): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket || ticket.status !== 'stopped') throw new Error(`${id} is not stopped`)
    const s = ticket.stopped
    if (!ticket.worktree || !s || s.task === 'queued') {
      this.enqueue(id, ticket.maxEffort ? 'max' : (ticket.lane ?? ticket.suggestedLane), ticket.engine)
      this.pump()
      return
    }
    if (s.task === 'visual') {
      this.store.patch(id, { status: s.from }, { kind: 'resume', message: 'visual check again' })
      await this.runVisualCheck(id)
      return
    }
    const note = path.join(this.flowDir(id), 'RESUME.md')
    const prompt = resumePrompt(s.reason, note)
    this.store.patch(id, { status: 'running' }, { kind: 'resume', message: 'resumed after a stop' })
    this.store.journal(id, { kind: 'note', title: 'Resumed after a stop' })
    this.begin(id)
    try {
      await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: Boolean(ticket.prUrl) })
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // Merges origin/<base> into the ticket's branch (a merge, so the PR never needs a force push).
  // Clean and green: pushed to the open PR. Conflicts or red gates: the lane fixes them and the
  // ticket comes back for your review.
  async updateFromMain(id: string): Promise<'pushed' | 'merged' | 'lane'> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id} has no worktree`)
    if (this.active.has(id) || ticket.status === 'running' || ticket.status === 'queued') throw new Error(`${id} has a lane running; try when it finishes`)
    const wt = ticket.worktree
    const base = `origin/${this.cfg.repo.baseBranch}`
    if (await hasUncommitted({ path: wt, flowDir: '', branch: ticket.branch, base: '' })) throw new Error(`${id} has uncommitted changes in its worktree; commit or discard them first`)
    const prevStatus = ticket.status
    const signal = this.begin(id)
    this.store.patch(id, { status: 'running' }, { kind: 'update', message: `merging ${base}` })
    this.progress(ticket, 'stage', `merging ${base}`)
    try {
      await git(['fetch', 'origin', this.cfg.repo.baseBranch], wt)
      const behind = Number(await git(['rev-list', '--count', `HEAD..${base}`], wt)) || 0
      let conflicts: string[] = []
      try {
        await git(['merge', '--no-edit', base], wt)
      } catch {
        conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], wt)).split('\n').filter(Boolean)
        if (conflicts.length === 0) throw new Error(`git merge ${base} failed; see the worktree`)
      }
      if (conflicts.length > 0) {
        this.store.journal(id, { kind: 'note', title: `Merging ${base} hit conflicts`, body: conflicts.join('\n') })
        const prompt = mergeConflictPrompt(base, this.cfg.repo.baseBranch, behind, conflicts, this.flowDir(id))
        await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: true })
        return 'lane'
      }
      this.progress(ticket, 'stage', 're-running the gates after the merge')
      const gates = await runGates(this.cfg, wt, signal)
      this.checkStopped(id)
      const red = gates.filter((g) => !g.ok)
      if (red.length > 0) {
        this.store.journal(id, { kind: 'failure', title: `Gates failed after merging ${base}`, body: red.map((g) => `${g.name}\n${g.tail}`).join('\n\n') })
        const prompt = mergeGatesPrompt(base, red, this.flowDir(id))
        await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: true })
        return 'lane'
      }
      const wtInfo: Worktree = { path: wt, flowDir: this.flowDir(id), branch: ticket.branch, base: '' }
      const facts = { commits: await localCommits(wtInfo, this.cfg.repo.baseBranch), diffStat: await diffStat(wtInfo, this.cfg.repo.baseBranch) }
      const { behindMain: _clear, ...rest } = this.store.get(id) as Ticket
      this.store.upsert(rest)
      if (prevStatus === 'pr_draft' && ticket.prUrl) {
        await pushBranch(wt, ticket.branch)
        const sha = await git(['rev-parse', 'HEAD'], wt)
        this.store.patch(id, { ...facts, status: 'pr_draft', pushedSha: sha, lastPushAt: new Date().toISOString() }, { kind: 'update', message: `merged ${behind} commit(s) from ${base} and pushed` })
        this.store.journal(id, { kind: 'pr', title: `Updated from ${this.cfg.repo.baseBranch} and pushed`, body: `${behind} commit(s) merged, ${gates.map((g) => g.name).join(', ') || 'no gates configured'} green.`, meta: { url: ticket.prUrl } })
        return 'pushed'
      }
      this.store.patch(id, { ...facts, status: prevStatus }, { kind: 'update', message: `merged ${behind} commit(s) from ${base}` })
      this.store.journal(id, { kind: 'note', title: `Merged ${this.cfg.repo.baseBranch} into the branch`, body: `${behind} commit(s), gates green. Not pushed.` })
      return 'merged'
    } catch (error) {
      if (!(error instanceof Stopped) && !this.stopping.has(id)) {
        this.store.patch(id, { status: prevStatus })
        this.store.journal(id, { kind: 'failure', title: `Update from ${this.cfg.repo.baseBranch} failed`, body: error instanceof Error ? error.message : String(error) })
      }
      throw error
    } finally {
      this.end(id)
      this.pump()
    }
  }

  markDone(id: string): void {
    this.store.patch(id, { status: 'done' }, { kind: 'decision', message: 'marked done by operator' })
  }

  skip(id: string): void {
    this.store.patch(id, { status: 'skipped' }, { kind: 'decision', message: 'skipped by operator' })
  }

  async answer(id: string, text: string): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket || ticket.status !== 'needs_input' || !ticket.sessionId) return
    if (this.active.has(id)) return
    this.store.patch(id, { status: 'running', question: '' }, { kind: 'answer', message: text })
    this.store.journal(id, { kind: 'answer', title: 'You answered the lane', body: text })
    this.begin(id)
    try {
      await this.runLane(id, text, { resume: ticket.sessionId })
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // A visual check on demand: no code changes, just the states that matter shot again at desktop
  // and mobile, compared with the previous shots, and an honest verdict. The ticket keeps its status.
  async runVisualCheck(id: string): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id} has no worktree yet`)
    if (this.active.has(id) || ticket.status === 'running' || ticket.status === 'queued') throw new Error(`${id} has a lane running; try when it finishes`)
    const flowDir = this.flowDir(id)
    const shots = path.join(flowDir, 'shots')
    const prev = path.join(flowDir, 'shots-prev')
    // keep the last set so the app can show before-this-run vs now
    if (existsSync(shots)) {
      rmSync(prev, { recursive: true, force: true })
      cpSync(shots, prev, { recursive: true })
    }
    const port = ticket.port ?? this.store.allocatePort(this.cfg.pipeline.portBase)
    const prompt = visualCheckPrompt(this.cfg, ticket, flowDir, port)
    const prevStatus = ticket.status
    this.tasks.set(id, { task: 'visual', from: prevStatus })
    this.store.patch(id, { status: 'running' }, { kind: 'review', message: 'visual check' })
    this.store.journal(id, { kind: 'review', title: 'Visual check started' })
    const signal = this.begin(id)
    try {
      const head = await git(['rev-parse', 'HEAD'], ticket.worktree)
      const role = this.resolve(this.cfg.roles.visual, null, this.cfg.models.review.model) ?? this.resolve('claude', null, this.cfg.models.review.model)
      if (!role) throw new Error('no engine for the visual check')
      const result = await role.engine.run({
        cwd: ticket.worktree,
        prompt,
        model: role.model,
        effort: this.effort,
        logFile: path.join(flowDir, 'logs', 'visual.jsonl'),
        onLine: (kind, line) => this.progress(ticket, kind, line),
        signal,
      })
      this.checkStopped(id)
      if (result.exitCode !== 0) throw new Error(`visual check exited ${result.exitCode}`)
      const moved = (await git(['rev-parse', 'HEAD'], ticket.worktree)) !== head
      const updated = this.store.patch(id, { status: prevStatus, ...visualPatch(flowDir) }, { kind: 'review', message: `visual check: ${readVisual(flowDir)?.verdict ?? 'no verdict'}` })
      this.store.journal(id, {
        kind: 'review',
        title: `Visual check · ${updated.visual?.verdict.replace('_', ' ') ?? 'no verdict written'}${moved ? ' (it made commits, check them)' : ''}`,
        body: updated.visual?.summary ?? result.text.slice(0, 2000),
        ...(result.costUsd ? { meta: { cost: Number(result.costUsd.toFixed(2)) } } : {}),
      })
      await this.notify.visualDone(updated)
    } catch (error) {
      if (error instanceof Stopped || this.stopping.has(id)) return
      this.store.patch(id, { status: prevStatus })
      this.store.journal(id, { kind: 'failure', title: 'Visual check failed', body: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // The preview deploy for the PR's head commit, from the deploy bot's comment.
  previewOf(id: string): { url: string; sha: string | null; current: boolean } | null {
    const t = this.store.get(id)
    const d = previewDeploy(t?.pr?.comments ?? [])
    if (!d) return null
    const head = t?.pr?.headSha ?? ''
    return { ...d, current: !d.sha || !head || head.startsWith(d.sha) || d.sha.startsWith(head) }
  }

  // A QA round on the deployed preview: the ticket's criteria and the PR's testing steps, driven in
  // a browser at desktop and mobile, with screenshots and a verdict. Nothing is posted by itself.
  async runPreviewQa(id: string, force = false): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.pr) throw new Error(`${id} has no PR yet`)
    if (this.active.has(id) || ticket.status === 'running' || ticket.status === 'queued') throw new Error(`${id} has a lane running; try when it finishes`)
    const preview = this.previewOf(id)
    if (!preview) throw new Error(`${id}: no preview deploy found on the PR yet`)
    if (!preview.current && !force) throw new Error(`${id}: the preview is from ${preview.sha?.slice(0, 7)}, the PR is at ${ticket.pr.headSha?.slice(0, 7)}; wait for the new deploy`)
    const flowDir = this.flowDir(id)
    const qaDir = path.join(flowDir, 'qa')
    rmSync(qaDir, { recursive: true, force: true })
    mkdirSync(qaDir, { recursive: true })
    rmSync(path.join(flowDir, 'QA.json'), { force: true })
    const base = { at: new Date().toISOString(), url: preview.url, sha: preview.sha }
    const prevStatus = ticket.status
    this.tasks.set(id, { task: 'visual', from: prevStatus })
    this.store.patch(id, { status: 'running', previewQa: { ...base, status: 'running' } }, { kind: 'review', message: 'QA on preview' })
    this.store.journal(id, { kind: 'review', title: 'QA on the preview started', meta: { url: preview.url } })
    const signal = this.begin(id)
    try {
      const live = await livePrBody(ticket.worktree, String(ticket.pr.number)).catch(() => ({ body: ticket.pr?.body ?? '' }))
      const role = this.resolve(this.cfg.roles.visual, null, this.cfg.models.review.model) ?? this.resolve('claude', null, this.cfg.models.review.model)
      if (!role) throw new Error('no engine for the QA round')
      const result = await role.engine.run({ cwd: ticket.worktree, prompt: previewQaPrompt(ticket, flowDir, preview.url, live.body), model: role.model, effort: this.effort, logFile: path.join(flowDir, 'logs', 'qa.jsonl'), onLine: (kind, line) => this.progress(ticket, kind, line), signal })
      this.checkStopped(id)
      if (result.exitCode !== 0) throw new Error(`QA round exited ${result.exitCode}`)
      const file = path.join(flowDir, 'QA.json')
      if (!existsSync(file)) throw new Error('the QA round wrote no QA.json')
      const qa = JSON.parse(readFileSync(file, 'utf8')) as { verdict?: string; summary?: string; checks?: { what?: string; result?: string; shot?: string; note?: string }[] }
      const verdict = qa.verdict === 'pass' || qa.verdict === 'fail' ? qa.verdict : 'partial'
      const checks = (qa.checks ?? []).map((c) => ({ what: c.what ?? '', result: (c.result === 'pass' || c.result === 'fail' ? c.result : 'not_checked') as 'pass' | 'fail' | 'not_checked', ...(c.shot ? { shot: path.basename(c.shot) } : {}), ...(c.note ? { note: c.note } : {}) }))
      const updated = this.store.patch(id, { status: prevStatus, previewQa: { ...base, status: 'done', verdict, summary: qa.summary ?? '', checks } }, { kind: 'review', message: `QA on preview: ${verdict}` })
      this.store.journal(id, { kind: 'review', title: `QA on the preview · ${verdict}`, body: qa.summary ?? '', meta: { url: preview.url, ...(result.costUsd ? { cost: Number(result.costUsd.toFixed(2)) } : {}) } })
      await this.notify.previewQaDone(updated)
    } catch (error) {
      if (error instanceof Stopped || this.stopping.has(id)) return
      this.store.patch(id, { status: prevStatus, previewQa: { ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) } })
      throw error
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // Posts the QA round as a PR comment: where and on which commit it ran, each check, the screenshots.
  async postPreviewQa(id: string): Promise<string | null> {
    const t = this.store.get(id)
    const qa = t?.previewQa
    if (!t?.worktree || !t.pr || !t.prUrl) throw new Error(`${id} has no PR`)
    if (qa?.status !== 'done') throw new Error(`${id}: no finished QA round to post`)
    const mark = { pass: '✅', fail: '❌', not_checked: '➖' } as const
    const shots = (qa.checks ?? []).map((c) => c.shot).filter((x): x is string => Boolean(x))
    const files = [...new Set(shots)].map((s) => path.join(this.flowDir(id), 'qa', s)).filter((f) => existsSync(f))
    const sha = qa.sha ? ` at \`${qa.sha.slice(0, 7)}\`` : ''
    const passed = (qa.checks ?? []).filter((c) => c.result === 'pass').length
    const text = [
      `**Tested on the preview deploy**${sha}: ${qa.url}`,
      `**${qa.verdict}** · ${passed}/${qa.checks?.length ?? 0} checks passed · ${qa.summary ?? ''}`,
      ...(qa.checks ?? []).map((c) => `- ${mark[c.result]} ${c.what}${c.note ? ` (${c.note})` : ''}`),
    ].join('\n')
    const url = await this.pr.postNote(t, `QA on preview`, text, files)
    this.store.patch(id, { previewQa: { ...qa, postedAt: new Date().toISOString() } })
    return url
  }

  // Claude Code in your terminal, in the ticket's worktree: the lane's own session when it is
  // free, otherwise a fresh read-only one that reads the brief, the summary and the diff first.
  async openClaude(id: string): Promise<{ app: string; resumed: boolean }> {
    const t = this.store.get(id)
    if (!t?.worktree || !existsSync(t.worktree)) throw new Error(`${id} has no worktree yet`)
    const busy = this.active.has(id) || t.status === 'running' || t.status === 'queued'
    const { command, resumed } = claudeCommand(t, this.flowDir(id), this.cfg.repo.baseBranch, busy)
    const app = await openTerminal(t.worktree, command, id, this.cfg.pipeline.terminal)
    this.store.journal(id, { kind: 'note', title: `Opened in Claude (${app})${resumed ? ' · the lane\'s session' : ''}` })
    return { app, resumed }
  }

  // Unticked checks in the PR description that a new visual check or fix could resolve.
  async openChecks(id: string): Promise<number> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.prUrl) return 0
    const live = await livePrBody(ticket.worktree, ticket.pr?.number ? String(ticket.pr.number) : ticket.branch)
    return openChecks(live.body)
  }

  // An agent reads the live PR description, the latest visual check and the commits, and proposes
  // line changes (ticks, known gaps, regression). Nothing is posted until you apply it.
  async proposeDescription(id: string, trigger: 'visual' | 'manual'): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.prUrl) throw new Error(`${id} has no PR yet`)
    if (this.active.has(id) || ticket.status === 'running' || ticket.status === 'queued') throw new Error(`${id} has a lane running; try when it finishes`)
    if (ticket.descProposal?.status === 'preparing') throw new Error(`${id}: already preparing the description changes`)
    const worktree = ticket.worktree
    const flowDir = this.flowDir(id)
    const sha = await git(['rev-parse', 'HEAD'], worktree)
    const base = { trigger, at: new Date().toISOString(), sha, changes: [], log: '', comment: '' }
    this.store.patch(id, { descProposal: { ...base, status: 'preparing' } })
    try {
      const live = await livePrBody(worktree, ticket.pr?.number ? String(ticket.pr.number) : ticket.branch)
      writeFileSync(path.join(flowDir, 'PR-LIVE.md'), live.body)
      rmSync(path.join(flowDir, 'DESC-PATCH.json'), { force: true })
      const role = this.resolve(this.cfg.roles.reviewer, null, this.cfg.models.review.model) ?? this.resolve('claude', null, this.cfg.models.review.model)
      if (!role) throw new Error('no engine to read the description')
      const result = await role.engine.run({ cwd: worktree, prompt: descPrompt(flowDir, worktree, this.cfg.repo.baseBranch, trigger), model: role.model, effort: 'low', logFile: path.join(flowDir, 'logs', 'desc.jsonl') })
      if (result.exitCode !== 0) throw new Error(`the agent exited ${result.exitCode}`)
      const patch = readPatch(path.join(flowDir, 'DESC-PATCH.json'), live.body)
      const updated = this.store.patch(id, { descProposal: { ...base, status: 'ready', ...patch } })
      this.store.journal(id, { kind: 'review', title: `Proposed ${patch.changes.length} change(s) to the PR description`, body: patch.log, ...(result.costUsd ? { meta: { cost: Number(result.costUsd.toFixed(2)) } } : {}) })
      await this.notify.descReady(updated)
    } catch (error) {
      this.store.patch(id, { descProposal: { ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
  }

  dropDescProposal(id: string): void {
    const t = this.store.get(id)
    if (!t) return
    const { descProposal: _drop, ...rest } = t
    this.store.upsert(rest)
  }

  // Applies the proposal (only the changes you kept) to the PR description, with the retaken
  // screenshots, a dated Updates line and an optional short comment.
  async applyDescription(id: string, input: { accept?: readonly string[]; comment?: string | null; log?: string }): Promise<{ url: string | null; applied: number; skipped: number }> {
    const ticket = this.store.get(id)
    const p = ticket?.descProposal
    if (!ticket?.worktree || !ticket.prUrl) throw new Error(`${id} has no PR yet`)
    if (!p || p.status !== 'ready') throw new Error(`${id}: no description changes ready to apply`)
    const changes = input.accept ? p.changes.filter((c) => input.accept?.includes(c.id)) : p.changes
    const since = Date.parse(ticket.visualPostedAt ?? ticket.lastPushAt ?? '1970-01-01')
    const comment = input.comment === undefined ? p.comment : input.comment
    const result = await this.pr.updateDescription(ticket, p.sha, { changes, log: input.log ?? p.log, comment: comment?.trim() ? comment.trim() : null, since })
    this.dropDescProposal(id)
    this.store.patch(id, { visualPostedAt: new Date().toISOString() })
    return result
  }

  // Posts the latest visual check to the PR as a comment: verdict, checks, and the shots taken since the last post.
  async postVisual(id: string): Promise<string | null> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.prUrl) throw new Error(`${id} has no PR yet`)
    const v = ticket.visual
    if (!v) throw new Error(`${id} has no visual check to post`)
    const mark = { pass: '✅', fail: '❌', not_checked: '➖' } as const
    const text = [`**${v.verdict.replace('_', ' ')}** · ${v.summary}`, ...v.checks.map((c) => `- ${mark[c.result]} ${c.what}${c.note ? ` (${c.note})` : ''}`)].join('\n')
    const since = Date.parse(ticket.visualPostedAt ?? ticket.lastPushAt ?? '1970-01-01')
    const sha = await git(['rev-parse', 'HEAD'], ticket.worktree)
    const url = await this.pr.postUpdate(ticket, sha, { text, since })
    this.store.patch(id, { visualPostedAt: new Date().toISOString() })
    return url
  }

  setVisualOverride(id: string, value: 'on' | 'off' | null): void {
    const t = this.store.get(id)
    if (!t) return
    const { visualOverride: _drop, ...rest } = t
    this.store.upsert(value ? { ...rest, visualOverride: value } : rest)
  }

  // Asks Greptile for a fresh review now (after a push made outside metwo, for example).
  async retagGreptile(id: string): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.prUrl) throw new Error(`${id} has no PR`)
    await commentOnPr(ticket.worktree, ticket.pr?.number ? String(ticket.pr.number) : ticket.branch, this.cfg.github.greptile.trigger)
    this.store.journal(id, { kind: 'comment', title: `Asked Greptile to review (${this.cfg.github.greptile.trigger})` })
  }

  // Teammates' comments only (bots like Greptile and preview deploys have their own flow).
  // The comments you picked (all open ones from teammates when you pick none), each with your
  // optional note, go back to the lane. The rest stay open for later.
  async addressComments(id: string, picks?: readonly { id: string; note?: string }[]): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.pr) throw new Error(`${id}: no PR to address`)
    const me = await ghLogin(ticket.worktree).catch(() => '')
    if (this.active.has(id) || ticket.status === 'running') throw new Error(`${id} has a lane running; try when it finishes`)
    const handled = ticket.commentsHandled ?? {}
    const comments = picks?.length
      ? ticket.pr.comments.filter((c) => picks.some((p) => p.id === c.id))
      : openComments(ticket).filter((c) => c.author !== me && !c.body.trim().startsWith(this.cfg.github.greptile.trigger))
    if (comments.length === 0) throw new Error(`${id}: no open comments to address`)
    const notes = (picks ?? []).filter((p) => p.note?.trim()).map((p) => {
      const c = comments.find((x) => x.id === p.id)
      return `- On ${c?.author ?? 'a'}'s comment "${(c?.body ?? '').replace(/\s+/g, ' ').slice(0, 80)}": ${p.note?.trim()}`
    })
    const list = `${formatComments(comments)}${notes.length ? `\n\nThe ticket owner's notes on these comments (follow them):\n${notes.join('\n')}` : ''}`
    const prompt = commentsPrompt(ticket.id, ticket.pr.url, this.flowDir(id), list)
    const at = new Date().toISOString()
    this.store.patch(
      id,
      { status: 'running', commentsHandled: { ...handled, ...Object.fromEntries(comments.map((c) => [c.id, { at, how: 'addressed' as const }])) }, pendingReplies: comments.map((c) => ({ id: c.id, kind: c.kind, author: c.author, body: c.body, url: c.url })) },
      { kind: 'fix-comments', message: `addressing ${comments.length} comment(s)` },
    )
    this.store.journal(id, { kind: 'answer', title: `Sent ${comments.length} PR comment(s) back to the lane`, body: formatComments(comments) })
    this.begin(id)
    try {
      await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: true })
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // Comments you set aside (a question you answered elsewhere, an "lgtm").
  ignoreComments(id: string, ids: readonly string[]): void {
    const t = this.store.get(id)
    if (!t) return
    const at = new Date().toISOString()
    this.store.patch(id, { commentsHandled: { ...(t.commentsHandled ?? {}), ...Object.fromEntries(ids.map((c) => [c, { at, how: 'ignored' as const }])) } })
  }

  reopenComment(id: string, commentId: string): void {
    const t = this.store.get(id)
    if (!t?.commentsHandled?.[commentId]) return
    const { [commentId]: _drop, ...rest } = t.commentsHandled
    this.store.patch(id, { commentsHandled: rest })
  }

  // A reply drafted from the code and the comment, for you to edit before posting.
  async draftReply(id: string, commentId: string, hint = ''): Promise<string> {
    const t = this.store.get(id)
    const c = t?.pr?.comments.find((x) => x.id === commentId)
    if (!t?.worktree || !c) throw new Error(`${id}: comment not found`)
    const role = this.resolve(this.cfg.roles.reviewer, null, this.cfg.models.review.model) ?? this.resolve('claude', null, this.cfg.models.review.model)
    if (!role) throw new Error('no engine to draft with')
    const prompt = `Draft a reply to this PR review comment on ${t.id}, as the PR author. Look at the code it refers to in this worktree first (read-only: change nothing, run nothing that writes).
${hint ? `The author wants to say: ${hint}\n` : ''}Comment by ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}:
${c.body}

Reply in 1 to 3 short sentences, plain and friendly, no greeting, no sign-off, no AI mention. If the comment is right and still unfixed, say what will change. Output only the reply text.`
    const result = await role.engine.run({ cwd: t.worktree, prompt, model: role.model, effort: 'low', logFile: path.join(this.flowDir(id), 'logs', 'reply.jsonl') })
    if (result.exitCode !== 0 || !result.text.trim()) throw new Error('could not draft a reply')
    return result.text.trim()
  }

  // Posts your reply: in the thread for an inline comment, as a quoting comment otherwise.
  async replyComment(id: string, commentId: string, body: string): Promise<string | null> {
    const t = this.store.get(id)
    const c = t?.pr?.comments.find((x) => x.id === commentId)
    if (!t?.worktree || !t.pr || !c) throw new Error(`${id}: comment not found`)
    let url: string | null = null
    if (c.kind === 'inline') await replyToReviewComment(t.worktree, t.pr.number, c.id.replace(/^inline-/, ''), body.trim())
    else url = await commentOnPr(t.worktree, String(t.pr.number), `> **@${c.author}**: ${c.body.replace(/\s+/g, ' ').trim().slice(0, 200)}\n\n${body.trim()}`)
    const at = new Date().toISOString()
    this.store.patch(id, { commentsHandled: { ...(t.commentsHandled ?? {}), [c.id]: { at, how: 'replied' } } })
    this.store.journal(id, { kind: 'comment', title: `Replied to ${c.author}`, body: body.trim(), ...(url ? { meta: { url } } : {}) })
    return url
  }

  // Your own instruction on a ticket ("the title overlaps the back button"), with optional
  // screenshots. Saved next to the brief, sent into the ticket's session, and the ticket lands
  // in review again with the new commits, so nothing is pushed without you.
  async instruct(id: string, text: string, images: readonly { name: string; bytes: Buffer }[] = []): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id} has no worktree yet; start it first`)
    const busy = this.active.has(id) || ticket.status === 'running' || ticket.status === 'queued'
    if (busy && ticket.queuedInstruction) throw new Error(`${id} already has an instruction waiting for this run to end`)
    const n = (ticket.journal ?? []).filter((j) => j.kind === 'note' && j.title.startsWith('You asked')).length + 1
    const dir = path.join(this.flowDir(id), 'feedback')
    mkdirSync(dir, { recursive: true })
    const saved = images.map((img, i) => {
      const ext = (path.extname(img.name) || '.png').toLowerCase()
      const file = path.join(dir, `${String(n).padStart(2, '0')}-${i + 1}${ext}`)
      writeFileSync(file, img.bytes)
      return file
    })
    if (busy) {
      this.store.patch(id, { queuedInstruction: { text, images: saved, at: new Date().toISOString() } })
      this.store.journal(id, { kind: 'note', title: 'Queued for when this run ends', body: text })
      return
    }
    await this.sendInstruction(id, text, saved)
  }

  dropQueued(id: string): Ticket {
    return this.store.patch(id, { queuedInstruction: null })
  }

  private async sendInstruction(id: string, text: string, saved: readonly string[]): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id} has no worktree`)
    const visual = saved.length > 0 || /visual|overlap|layout|align|spacing|padding|title|icon|button|screen|mobile|desktop|color|font/i.test(text)
    const prompt = instructPrompt(ticket.id, ticket.prUrl, text, saved, visual, this.flowDir(id))
    this.store.patch(id, { status: 'running' }, { kind: 'answer', message: `your instruction: ${text.slice(0, 120)}` })
    this.store.journal(id, { kind: 'note', title: `You asked the lane${saved.length ? ` (${saved.length} image${saved.length === 1 ? '' : 's'})` : ''}`, body: text, ...(saved.length ? { meta: { images: saved.map((f) => path.basename(f)).join(', ') } } : {}) })
    this.begin(id)
    try {
      await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: true })
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  private flowDir(id: string): string {
    return path.join(this.cfg.repo.path, this.cfg.repo.worktreesDir, `${id}-flow`)
  }

  // Each step shows on the card and the ticket page; a failure says why and stays until the next try.
  async push(id: string): Promise<void> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id} has no worktree`)
    if (ticket.pushing && !ticket.pushing.error && Date.now() - Date.parse(ticket.pushing.at) < 10 * 60_000) throw new Error(`${id}: already pushing (${ticket.pushing.step})`)
    const step = (s: string) => this.store.patch(id, { pushing: { at: new Date().toISOString(), step: s } })
    try {
      await this.pushSteps(id, ticket, step)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.patch(id, { pushing: { at: new Date().toISOString(), step: 'failed', error: message.slice(0, 1500) } })
      this.store.journal(id, { kind: 'failure', title: 'Push failed', body: message })
      throw error
    }
    const done = this.store.get(id)
    if (done?.pushing) {
      const { pushing: _drop, ...rest } = done
      this.store.upsert(rest)
    }
  }

  private async pushSteps(id: string, ticket: Ticket, step: (s: string) => void): Promise<void> {
    const wt = ticket.worktree as string
    step('checking the PR branch on GitHub')
    // commits pushed on GitHub (its "Update branch" button, a teammate) would make the push bounce
    await git(['fetch', 'origin', ticket.branch], wt).catch(() => undefined)
    const remote = `origin/${ticket.branch}`
    const hasRemote = await git(['rev-parse', '--verify', '--quiet', remote], wt).then(() => true, () => false)
    if (hasRemote) {
      const behind = Number(await git(['rev-list', '--count', `HEAD..${remote}`], wt).catch(() => '0')) || 0
      if (behind > 0) {
        step(`bringing in ${behind} commit(s) that are on the PR but not here`)
        try {
          await git(['merge', '--no-edit', remote], wt)
        } catch {
          const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], wt).catch(() => '')).split('\n').filter(Boolean)
          await git(['merge', '--abort'], wt).catch(() => undefined)
          throw new Error(`The PR has ${behind} commit(s) from GitHub that conflict with yours${conflicts.length ? ` in ${conflicts.slice(0, 5).join(', ')}` : ''}. Use Update from main (the lane resolves it) or merge ${remote} in the worktree, then push again.`)
        }
        this.store.journal(id, { kind: 'pr', title: `Merged ${behind} commit(s) from the PR branch before pushing`, body: 'They were pushed on GitHub (for example its Update branch button), so the push would have been rejected without them.' })
      }
    }
    const existing = await existingPrUrl(wt, ticket.branch)
    step(existing ? 'pushing to the PR' : 'pushing the branch')
    await pushBranch(wt, ticket.branch)
    const greptile = this.cfg.github.greptile
    let prUrl = existing
    if (!existing) {
      step('opening the draft PR')
      prUrl = await this.pr.openWithMedia(ticket)
    } else {
      this.store.journal(id, { kind: 'pr', title: 'Pushed to the existing PR', body: ticket.commits ?? '', meta: { url: existing } })
      step('posting the update on the PR')
      const sha = await git(['rev-parse', 'HEAD'], wt)
      await this.pr.postUpdate({ ...ticket, prUrl: existing }, sha).catch((e: unknown) => log.warn(`${id}: update comment failed`, e))
    }
    // every push gets a fresh review: Greptile does not re-run on a draft by itself
    if (greptile.enabled) {
      try {
        step('asking Greptile to review')
        await commentOnPr(wt, ticket.branch, greptile.trigger)
        this.store.journal(id, { kind: 'comment', title: `Asked Greptile to review (${greptile.trigger})` })
      } catch (error) {
        log.warn(`${id}: could not tag greptile`, error)
      }
    }
    const pushedSha = await git(['rev-parse', 'HEAD'], wt).catch(() => '')
    const updated = this.store.patch(id, { status: 'pr_draft', prUrl: prUrl ?? '', greptileFixing: false, lastPushAt: new Date().toISOString(), pendingReplies: [], ...(pushedSha ? { pushedSha } : {}) }, { kind: 'pr', message: existing ? `pushed to existing PR ${prUrl}` : `draft PR ${prUrl}` })
    await this.notify.prOpened(updated)
  }

  // Takes the draft out of draft so teammates get the review request, then asks GitHub's
  // suggested reviewers. Your gh, your name.
  async markReady(id: string): Promise<{ ticket: Ticket; reviewers: readonly string[] }> {
    const ticket = this.store.get(id)
    if (!ticket?.worktree || !ticket.prUrl) throw new Error(`${id} has no PR yet`)
    if (ticket.pr && !ticket.pr.isDraft) throw new Error(`${id}: PR is already ready for review`)
    await markPrReady(ticket.worktree, ticket.branch)
    let reviewers: readonly string[] = []
    const rc = this.cfg.github.reviewers
    if (rc.auto && rc.max > 0) {
      try {
        reviewers = await requestSuggestedReviewers(ticket.worktree, ticket.branch, rc.max)
      } catch (error) {
        log.warn(`${id}: could not request reviewers`, error)
      }
    }
    const score = ticket.pr?.greptile?.score
    const notes = [score ? `Greptile ${score}/5` : '', reviewers.length ? `Review requested from ${reviewers.join(', ')}` : 'No suggested reviewers to add'].filter(Boolean)
    this.store.journal(id, { kind: 'pr', title: 'Marked the PR ready for review', body: notes.join('\n'), meta: { url: ticket.prUrl } })
    const updated = this.store.patch(id, ticket.pr ? { pr: { ...ticket.pr, isDraft: false } } : {}, { kind: 'pr', message: `ready for review${reviewers.length ? ` · ${reviewers.join(', ')}` : ''}` })
    return { ticket: updated, reviewers }
  }

  // A screenshot or video from the flow dir, by bare file name only.
  mediaFile(id: string, name: string): string | null {
    return this.pr.mediaFile(id, name)
  }

  mediaList(id: string): readonly MediaFile[] {
    return this.pr.mediaList(id)
  }

  // What the PR will say before it exists.
  previewBody(id: string): { body: string; media: readonly { name: string; kind: 'image' | 'video' }[] } {
    return this.pr.previewBody(id)
  }

  // Sends Greptile's latest findings to the lane. It fixes what is valid, commits, and the
  // ticket goes back to review_ready so nothing is pushed without you.
  async fixGreptile(id: string): Promise<void> {
    const ticket = this.store.get(id)
    const review = ticket?.pr?.greptile
    if (!ticket?.worktree || !review) throw new Error(`${id}: no Greptile review to address`)
    if (review.findings.length === 0) throw new Error(`${id}: Greptile found nothing to fix`)
    if (this.active.has(id)) throw new Error(`${id}: a lane is already running`)
    const list = review.findings
      .map((f, i) => `### ${i + 1}. ${f.level ? `[${f.level}] ` : ''}${f.title}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}\n${f.body.trim()}`)
      .join('\n\n')
    const prompt = greptilePrompt(ticket.id, review.url, review.score, list, this.flowDir(id))
    const head = await git(['rev-parse', 'HEAD'], ticket.worktree)
    this.store.patch(id, { status: 'running', greptileFixing: true }, { kind: 'fix-comments', message: `fixing ${review.findings.length} Greptile finding(s)` })
    this.store.journal(id, { kind: 'answer', title: `Sent ${review.findings.length} Greptile finding(s) to the lane`, body: list })
    this.begin(id)
    try {
      await this.runLane(id, prompt, { resume: ticket.sessionId, followUp: true })
      const after = this.store.get(id)
      if (after?.status === 'review_ready' && (await git(['rev-parse', 'HEAD'], ticket.worktree)) === head) {
        // nothing committed: every finding was declined, so the PR stays as it is
        const back = this.store.patch(id, { status: 'pr_draft', greptileFixing: false }, { kind: 'review', message: 'Greptile findings reviewed, no change needed' })
        this.store.journal(id, { kind: 'review', title: 'Greptile findings declined', body: markdownSection(back.summary, 'Greptile') })
        await this.notify.greptileDeclined(back)
      }
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  private async run(id: string): Promise<void> {
    if (this.active.has(id)) return
    this.begin(id)
    try {
      const ticket = this.store.get(id)
      if (!ticket) return
      // flip right away so the board and Telegram never show a started ticket as queued
      this.store.patch(id, { status: 'running' })
      const wt = await ensureWorktree(this.cfg.repo, ticket.id, ticket.branch)
      const port = ticket.port ?? this.store.allocatePort(this.cfg.pipeline.portBase)
      this.progress(ticket, 'stage', 'reading the ticket')
      const ctx = await gatherContext(this.linear, ticket, wt.flowDir)
      const briefPath = writeBrief(this.cfg, ticket, wt.path, wt.flowDir, port, contextSection(ctx), this.learnings?.rules() ?? '')
      if (ctx.images.length > 0 || ctx.comments.length > 0) {
        this.store.journal(id, {
          kind: 'note',
          title: 'Brief context',
          body: `${ctx.images.length} image(s) and ${ctx.comments.length} Linear comment(s) added to the brief`,
        })
      }
      this.store.patch(id, { status: 'running', worktree: wt.path, port }, { kind: 'start', message: `worktree ${wt.path} @ ${wt.base.slice(0, 8)}, port ${port}` })
      if (this.cfg.linear.moveToInProgressOnStart || ticket.autopilot) {
        await this.linear.moveToState(ticket.uuid, this.cfg.linear.states.inProgress).then(
          () => this.store.patch(id, { linearState: this.cfg.linear.states.inProgress }),
          (e: unknown) => log.warn(`${id}: linear move failed`, e),
        )
      }
      const prompt = `Read ${briefPath} and execute it. Your worktree is ${wt.path}; commit to branch ${ticket.branch}.`
      await this.runLane(id, prompt, {})
    } catch (error) {
      await this.fail(id, error)
    } finally {
      this.end(id)
      this.pump()
    }
  }

  // One claude turn (fresh or resumed), then inspect the worktree to decide the next state.
  private async reviewPass(ticket: Ticket, wt: Worktree, implementer: EngineId): Promise<void> {
    const role = this.resolve(this.cfg.roles.reviewer, implementer, this.cfg.models.review.model)
    if (!role) return
    this.store.patch(ticket.id, {}, { kind: 'review', message: `review pass on ${role.engine.label}` })
    this.progress(ticket, 'stage', `review pass on ${role.engine.label}`)
    const review = await role.engine.run({
      cwd: wt.path,
      prompt: reviewPrompt(this.cfg, ticket, wt.path),
      model: role.model,
      effort: this.effort,
      logFile: path.join(wt.flowDir, 'logs', 'review.jsonl'),
      onLine: (kind, line) => this.progress(ticket, kind, line),
      signal: this.signalOf(ticket.id),
    })
    this.checkStopped(ticket.id)
    if (review.exitCode !== 0) log.warn(`${ticket.id}: review pass exited ${review.exitCode}`)
    this.store.journal(ticket.id, {
      kind: 'review',
      title: `Review pass · ${role.engine.label}`,
      body: review.text.slice(0, 4000),
      meta: { model: `${review.model ?? role.model}/${this.effort}`, ...(review.costUsd ? { cost: Number(review.costUsd.toFixed(2)) } : {}), ...(review.tokens ? { tokens: review.tokens } : {}) },
    })
  }

  // metwo re-runs the gates; if green, a different vendor checks the work against the ticket.
  private async supervise(ticket: Ticket, wt: Worktree, implementer: EngineId, round: number): Promise<SupervisionReport | null> {
    const role = this.resolve(this.cfg.roles.supervisor, implementer, this.cfg.models.review.model)
    if (!role) return null
    this.progress(ticket, 'stage', 're-running the gates')
    const gates = await runGates(this.cfg, wt.path, this.signalOf(ticket.id))
    this.checkStopped(ticket.id)
    let report: SupervisionReport
    if (gates.some((g) => !g.ok)) {
      report = gatesFailed(role.engine.label, gates, round)
    } else {
      this.progress(ticket, 'stage', `supervisor: ${role.engine.label}`)
      const before = await git(['status', '--porcelain'], wt.path)
      const head = await git(['rev-parse', 'HEAD'], wt.path)
      const result = await role.engine.run({
        cwd: wt.path,
        prompt: supervisorPrompt(this.cfg, ticket, wt.path, wt.flowDir, gates),
        model: role.model,
        effort: this.effort,
        logFile: path.join(wt.flowDir, 'logs', 'supervisor.jsonl'),
        onLine: (kind, line) => this.progress(ticket, kind, line),
        signal: this.signalOf(ticket.id),
      })
      this.checkStopped(ticket.id)
      report = readSupervision(wt.flowDir, role.ref, gates, round)
      if (result.exitCode !== 0 && report.criteria.length === 0) report = { ...report, verdict: 'concerns', summary: `The supervisor (${role.engine.label}) exited ${result.exitCode}: ${result.stderr.split('\n').at(-1) ?? ''}` }
      const touched = (await git(['rev-parse', 'HEAD'], wt.path)) !== head || (await git(['status', '--porcelain'], wt.path)) !== before
      if (touched) this.store.journal(ticket.id, { kind: 'failure', title: 'The supervisor changed files it should only read', body: 'Check git status and git log in the worktree.' })
    }
    this.store.patch(ticket.id, { supervision: report })
    const failed = report.criteria.filter((c) => !c.met).length
    this.store.journal(ticket.id, {
      kind: 'review',
      title: `Supervisor · ${report.engine} · ${report.verdict}${round ? ` (round ${round})` : ''}`,
      body: [report.summary, failed ? `${failed} criterion(s) not met` : '', ...report.findings.map((f) => `[${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`)].filter(Boolean).join('\n'),
    })
    return report
  }

  // Why an autopilot ticket should wait for you instead of opening its PR; null when all is green.
  private async autopilotHold(ticket: Ticket, wt: Worktree): Promise<string | null> {
    const reasons: string[] = []
    const sup = ticket.supervision
    if (sup) {
      if (sup.verdict !== 'pass') reasons.push(`supervisor said ${sup.verdict}`)
    } else {
      const gates = await runGates(this.cfg, wt.path, this.signalOf(ticket.id))
      const red = gates.filter((g) => !g.ok).map((g) => g.name)
      if (red.length) reasons.push(`${red.join(', ')} failed`)
    }
    const v = ticket.visual
    const needsVisual = ticket.visualOverride === 'on' || (ticket.visualOverride !== 'off' && ticket.visualNeeded)
    if (needsVisual && v?.verdict !== 'verified') reasons.push(v ? `visual check ${v.verdict.replace('_', ' ')}` : 'no visual check')
    if (await hasUncommitted(wt)) reasons.push('uncommitted changes left in the worktree')
    return reasons.length ? reasons.join('; ') : null
  }

  // The ticket's implementer: its own engine if one was picked at start, else the lane's role.
  private implementer(ticket: Ticket, fresh = false): { engine: Engine; model: string; ref: string } {
    const lane = ticket.lane ?? 'lite'
    // a fresh lane you did not pin runs on the flat-plan or free engine when planFirst asks for it,
    // or when the budget is tight (lite) or used up (every lane)
    const b = this.budget()
    const planFirst = this.cfg.budget.planFirst
    const toPlan = planFirst === 'all' || (planFirst === 'lite' && lane === 'lite') || (b.regulate && (b.level === 'over' || (b.level === 'tight' && lane === 'lite')))
    if (fresh && !ticket.engine && toPlan && b.fallback) {
      const fb = this.resolve(b.fallback, null, this.cfg.models[lane].model)
      if (fb) return fb
    }
    return (this.resolve(ticket.engine ?? this.cfg.roles.implementer[lane], null, this.cfg.models[lane].model) ?? this.resolve('claude', null, this.cfg.models[lane].model)) as { engine: Engine; model: string; ref: string }
  }

  // One implementer turn (fresh or resumed), then review, supervision, and the next state.
  // `resume` is the ticket's session; it is only used when the same engine made it.
  private async runLane(id: string, prompt: string, opts: { resume?: string | undefined; round?: number; followUp?: boolean }): Promise<void> {
    const { resume, round = 0, followUp = false } = opts
    this.checkStopped(id)
    const ticket = this.store.get(id)
    if (!ticket?.worktree) throw new Error(`${id}: no worktree`)
    if (!this.tasks.has(id)) this.tasks.set(id, { task: 'lane', from: 'running' })
    const lane = ticket.lane ?? 'lite'
    const impl = this.implementer(ticket, !resume)
    const b = this.budget()
    const regulated = b.regulate && b.level !== 'normal'
    const effort = ticket.maxEffort ? ('max' as const) : regulated ? regulatedEffort(this.effort, lane, b.level) : this.effort
    const flowDir = this.flowDir(id)
    const logFile = path.join(flowDir, 'logs', 'lane.jsonl')
    const sameSession = Boolean(resume) && (ticket.sessionEngine ?? 'claude') === impl.engine.id
    const fullPrompt = resume && !sameSession ? `You are continuing work on ${id} in an existing worktree another engine started. Read ${path.join(flowDir, 'brief.md')}, ARM-SUMMARY.md and git log origin/${this.cfg.repo.baseBranch}..HEAD first.\n\n${prompt}` : prompt

    this.progress(ticket, 'stage', resume ? `resumed on ${impl.engine.label}` : `implementing on ${impl.engine.label}`)
    const started = Date.now()
    const result: RunResult = await impl.engine.run({
      cwd: ticket.worktree,
      prompt: fullPrompt,
      model: impl.model,
      effort,
      logFile,
      ...(sameSession && resume ? { resume } : {}),
      signal: this.signalOf(id),
      onLine: (kind, line) => this.progress(ticket, kind, line),
      onSession: (sessionId) => {
        if (this.store.get(id)?.sessionId !== sessionId) this.store.patch(id, { sessionId, sessionEngine: impl.engine.id })
      },
      onModel: (model) => {
        const t = this.store.get(id)
        if (t?.model !== model || t.effort !== effort) this.store.patch(id, { model, effort })
      },
    })
    if (result.sessionId) this.store.patch(id, { sessionId: result.sessionId, sessionEngine: impl.engine.id })
    const stopped = Boolean(this.signalOf(id)?.aborted)
    this.store.journal(id, {
      kind: 'run',
      title: `${resume ? 'Lane resumed' : 'Lane turn'} · ${impl.engine.label}${round ? ` (supervisor round ${round})` : ''}${stopped ? ' · stopped' : ''}`,
      body: result.text.slice(0, 4000),
      meta: {
        lane,
        model: `${result.model ?? impl.model ?? impl.engine.id}/${effort}`,
        minutes: Math.round((Date.now() - started) / 6000) / 10,
        ...(result.costUsd ? { cost: Number(result.costUsd.toFixed(2)) } : {}),
        ...(result.tokens ? { tokens: result.tokens } : {}),
        ...(result.exitCode !== 0 ? { exit: result.exitCode } : {}),
        ...(regulated ? { budget: b.level } : {}),
      },
    })
    if (stopped) throw new Stopped(id)
    if (result.exitCode !== 0) throw new Error(`${impl.engine.id} exited ${result.exitCode}${result.stderr ? `: ${result.stderr.split('\n').at(-1)}` : ''}; see ${logFile}`)
    if (impl.engine.id === 'claude') this.notify.claudeState(true, `last lane turn ok (${impl.model}/${effort})`)
    this.store.patch(id, {}, { kind: 'lane', message: `lane turn done${result.costUsd ? ` ($${result.costUsd.toFixed(2)})` : ''}` })

    const wt: Worktree = { path: ticket.worktree, flowDir, branch: ticket.branch, base: '' }
    const blockedFile = path.join(wt.path, 'ARM-BLOCKED.md')
    if (existsSync(blockedFile)) {
      const question = readFileSync(blockedFile, 'utf8').trim() || result.text
      unlinkSync(blockedFile)
      const updated = this.store.patch(id, { status: 'needs_input', question }, { kind: 'question', message: question.slice(0, 200) })
      this.store.journal(id, { kind: 'question', title: 'The lane asked you something', body: question })
      await this.notify.needsInput(updated)
      return
    }

    // Checked before the review pass: an empty diff has nothing to review.
    const summaryFile = path.join(wt.path, 'ARM-SUMMARY.md')
    const readSummary = () => (existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : result.text)
    const firstCommits = await localCommits(wt, this.cfg.repo.baseBranch)
    if (!firstCommits.trim()) {
      if (await hasUncommitted(wt)) throw new Error('lane left uncommitted changes and no commits')
      this.progress(ticket, 'stage', 'no change needed')
      const updated = this.store.patch(
        id,
        { status: 'no_change', summary: readSummary() },
        { kind: 'no-change', message: firstLine(result.text) },
      )
      this.store.journal(id, { kind: 'no_change', title: 'No code change needed', body: firstLine(result.text) })
      await this.notify.noChange(updated)
      return
    }

    // saving budget: lite tickets skip the extra review pass (the gates and the supervisor still run)
    if (this.cfg.pipeline.reviewPass && !followUp && round === 0 && !(regulated && lane === 'lite')) {
      this.pausePoint(id, 'the review pass')
      await this.reviewPass(ticket, wt, impl.engine.id)
    }

    // First implementation and the supervisor's own rounds get supervised; your follow-ups don't.
    if (!followUp) {
      this.pausePoint(id, 'the gates and the supervisor')
      const report = await this.supervise(ticket, wt, impl.engine.id, round)
      if (report && report.verdict !== 'pass' && round < this.cfg.roles.supervisorRounds) {
        this.pausePoint(id, `supervisor round ${round + 1}`)
        this.progress(ticket, 'stage', `supervisor: ${report.verdict}, back to the implementer`)
        await this.runLane(id, fixPrompt(report), { resume: this.store.get(id)?.sessionId, round: round + 1 })
        return
      }
    }

    const summary = readSummary()
    const commits = await localCommits(wt, this.cfg.repo.baseBranch)
    const stat = await diffStat(wt, this.cfg.repo.baseBranch)
    const dirty = await hasUncommitted(wt)

    this.progress(ticket, 'stage', 'review ready')
    const updated = this.store.patch(
      id,
      { status: 'review_ready', summary, commits, diffStat: stat, ...visualPatch(flowDir), visualNeeded: await touchesUi(wt.path, this.cfg.repo.baseBranch) },
      { kind: 'ready', message: `${commits.split('\n').length} commit(s)${dirty ? ', plus uncommitted changes' : ''}` },
    )
    this.store.journal(id, { kind: 'ready', title: `${commits.split('\n').filter(Boolean).length} commit(s) ready for your review`, body: `${commits}\n\n${stat.split('\n').at(-1)?.trim() ?? ''}` })
    if (this.cfg.pipeline.pushMode === 'auto') {
      await this.push(id)
      return
    }
    if (updated.autopilot && this.cfg.autopilot.autoPush && !followUp) {
      const held = await this.autopilotHold(updated, wt)
      if (!held) {
        this.store.journal(id, { kind: 'note', title: 'Autopilot: every check passed, opening the draft PR' })
        await this.push(id)
        return
      }
      const parked = this.store.patch(id, { autopilot: { ...updated.autopilot, held } })
      this.store.journal(id, { kind: 'note', title: 'Autopilot stopped before the PR', body: held })
      await this.notify.reviewReady(parked)
      return
    }
    await this.notify.reviewReady(updated)
  }
}


function visualPatch(flowDir: string): { visual?: VisualReport; visualAt?: string; visualStale?: boolean } {
  const visual = readVisual(flowDir)
  return visual ? { visual, visualAt: new Date().toISOString(), visualStale: false } : {}
}

// Anything rendered: components, styles, copy catalogs, stories.
async function touchesUi(worktree: string, base: string): Promise<boolean> {
  const files = await git(['diff', '--name-only', `origin/${base}...HEAD`], worktree).catch(() => '')
  return files.split('\n').some((f) => /\.(tsx|jsx|css|scss|svg)$|\/locales\/|\.po$/.test(f))
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 240) ?? 'no change needed'
}

// The stepper's phase for a stage line the runner reports.
function phaseOf(line: string): StagePhase {
  if (/^review pass/.test(line)) return 'review'
  if (/^re-running the gates$|^supervisor: (?!.*back to)/.test(line)) return 'checks'
  if (/^review ready|^no change/.test(line)) return 'ready'
  if (/^(reading the ticket|implementing|resumed|supervisor: .*back to|merging)/.test(line)) return 'implementing'
  return 'other'
}
