export type EngineId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'hermes'

export type Effort = 'low' | 'medium' | 'high' | 'max'

export interface RunOptions {
  readonly cwd: string
  readonly prompt: string
  // the engine's own model name; empty = the CLI's default
  readonly model: string
  readonly effort: Effort
  readonly logFile: string
  // a session id from this same engine; anything else starts fresh
  readonly resume?: string
  readonly onLine?: (kind: 'text' | 'tool', line: string) => void
  readonly onSession?: (sessionId: string) => void
  readonly onModel?: (model: string) => void
  // aborting kills the CLI and everything it started
  readonly signal?: AbortSignal | undefined
}

export interface RunResult {
  readonly sessionId: string | null
  readonly text: string
  readonly exitCode: number
  readonly costUsd: number | null
  readonly model: string | null
  readonly tokens: number | null
  // last lines of stderr, for failure messages
  readonly stderr: string
}

interface EngineHealth {
  readonly installed: boolean
  readonly signedIn: boolean | null
  readonly version: string | null
  readonly detail: string
}

export interface Engine {
  readonly id: EngineId
  readonly label: string
  run(opts: RunOptions): Promise<RunResult>
  health(): Promise<EngineHealth>
}
