import type { Config } from '../config.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { cursor } from './cursor.js'
import { hermesEngine } from './hermes.js'
import { opencode } from './opencode.js'
import type { Engine, EngineId } from './types.js'

export type { Engine, EngineId, RunResult } from './types.js'

// The engines this config turns on. Claude is always there: it is the default for every role.
export function enabledEngines(cfg: Config): ReadonlyMap<EngineId, Engine> {
  const map = new Map<EngineId, Engine>([['claude', claude]])
  if (cfg.engines.codex.enabled) map.set('codex', codex)
  if (cfg.engines.cursor.enabled) map.set('cursor', cursor)
  if (cfg.engines.opencode.enabled) map.set('opencode', opencode)
  if (cfg.engines.hermes.enabled) map.set('hermes', hermesEngine(cfg.engines.hermes.provider))
  return map
}

// "engine" or "engine:model" from the config or a start button.
export function parseEngineRef(ref: string): { engine: EngineId; model: string } {
  const [engine, ...rest] = ref.split(':')
  const id = (['claude', 'codex', 'cursor', 'opencode', 'hermes'] as const).find((e) => e === engine) ?? 'claude'
  return { engine: id, model: rest.join(':') }
}
