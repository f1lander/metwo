// The config file can describe the pipeline by stage (a "stages" block) instead of the flat keys.
// Each stages key is another name for a flat key; when both are set, the stages value wins.
type Json = Readonly<Record<string, unknown>>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// [key in stages, flat key]. A key that holds an object maps the whole object.
export const STAGE_KEYS: readonly (readonly [string, string])[] = [
  ['intake.autopilot', 'autopilot'],
  ['intake.triage', 'triage'],
  ['intake.readiness', 'readiness'],
  ['intake.classifier', 'classifier'],
  ['intake.watch', 'linear.watchStates'],

  ['implement.engine.lite', 'roles.implementer.lite'],
  ['implement.engine.full', 'roles.implementer.full'],
  ['implement.models.lite', 'models.lite.model'],
  ['implement.models.full', 'models.full.model'],
  ['implement.effort', 'pipeline.effort'],
  ['implement.maxParallel', 'pipeline.maxParallel'],
  ['implement.targetLines', 'quality.targetLines'],
  ['implement.principles', 'principles'],
  ['implement.knowledge', 'knowledge'],
  ['implement.wiki', 'wiki'],
  ['implement.figma', 'figma'],
  ['implement.context', 'steps.implement.context'],
  ['implement.instructions', 'steps.implement.instructions'],

  ['review.pass', 'pipeline.reviewPass'],
  ['review.engine', 'roles.reviewer'],
  ['review.model', 'models.review.model'],
  ['review.securityLens', 'quality.securityLens'],
  ['review.security', 'quality.security'],
  ['review.supervisor.engine', 'roles.supervisor'],
  ['review.supervisor.rounds', 'roles.supervisorRounds'],
  ['review.visual', 'roles.visual'],
  ['review.effort', 'steps.review.effort'],
  ['review.context', 'steps.review.context'],
  ['review.instructions', 'steps.review.instructions'],
  ['review.supervisor.effort', 'steps.supervisor.effort'],
  ['review.supervisor.context', 'steps.supervisor.context'],
  ['review.supervisor.instructions', 'steps.supervisor.instructions'],
  ['review.visualCheck', 'steps.visual'],
  ['review.shots', 'shots'],
  ['review.gates.test', 'repo.commands.test'],
  ['review.gates.typecheck', 'repo.commands.typecheck'],
  ['review.gates.lint', 'repo.commands.lint'],

  ['beforePr.localChecks', 'localChecks'],
  ['beforePr.maxLines', 'quality.maxLines'],
  ['beforePr.sizeIgnore', 'quality.sizeIgnore'],

  ['pr.draftOnFinish', 'pipeline.draftOnFinish'],
  ['pr.pushMode', 'pipeline.pushMode'],
  ['pr.screenshots', 'github.screenshots'],
  ['pr.greptile.minScore', 'quality.minGreptile'],
  ['pr.greptile', 'github.greptile'],
  ['pr.reviewers', 'github.reviewers'],
  ['pr.linearComments', 'linear.comments'],

  ['followUps.quick', 'quality.quick'],
  ['followUps.afterFix', 'afterFix'],
  ['followUps.autoUpdateFromMain', 'pipeline.autoUpdateFromMain'],
  ['followUps.autoPullPr', 'pipeline.autoPullPr'],
  ['followUps.qa', 'github.qa'],
  ['followUps.quickFix', 'steps.quick'],
]

const get = (o: unknown, key: string): unknown => key.split('.').reduce<unknown>((n, k) => (isObject(n) ? n[k] : undefined), o)

function set(o: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.')
  let node = o
  for (const p of parts.slice(0, -1)) {
    node[p] = isObject(node[p]) ? { ...(node[p] as Json) } : {}
    node = node[p] as Record<string, unknown>
  }
  const last = parts.at(-1) as string
  node[last] = isObject(value) && isObject(node[last]) ? { ...(node[last] as Json), ...value } : value
}

// stages keys that are not in STAGE_KEYS (typos), as "review.supervisr"
function unknown(stages: Json, prefix = ''): string[] {
  return Object.entries(stages).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    if (STAGE_KEYS.some(([s]) => s === key)) return []
    if (isObject(v) && STAGE_KEYS.some(([s]) => s.startsWith(`${key}.`))) return unknown(v, key)
    return [key]
  })
}

// The file's JSON with the stages block folded into the flat keys.
export function fromStages(file: Json): Json {
  const stages = file.stages
  if (stages === undefined) return file
  if (!isObject(stages)) throw new Error('ticketflow.config.json: "stages" must be an object')
  const bad = unknown(stages)
  if (bad.length) throw new Error(`ticketflow.config.json: unknown stages key${bad.length > 1 ? 's' : ''} ${bad.map((k) => `stages.${k}`).join(', ')} (see docs/pipeline.md)`)
  const { stages: _stages, ...out } = structuredClone(file) as Record<string, unknown>
  for (const [s, flat] of STAGE_KEYS) {
    const v = get(stages, s)
    if (v === undefined) continue
    // minScore is quality.minGreptile, mapped on its own
    if (s === 'pr.greptile' && isObject(v)) {
      const { minScore: _m, ...rest } = v
      set(out, flat, rest)
    } else set(out, flat, v)
  }
  return out
}

// The stages key for a flat key, for messages and the Pipeline tab ("roles.reviewer" → "review.engine").
export function stageKey(flat: string): string | null {
  return STAGE_KEYS.find(([, f]) => f === flat)?.[0] ?? null
}
