export type EngineId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'hermes'

export type Effort = 'low' | 'medium' | 'high' | 'max'

export interface RunOptions {
  readonly cwd: string
  readonly prompt: string
  // read and search only: no shell, no edits, no network tools (triage, questions, untrusted PRs)
  readonly readOnly?: boolean
  // with readOnly: also read-only git (log, show, diff, blame, status) to look at the history
  readonly gitRead?: boolean
  // no tools at all: everything it needs is in the prompt (untrusted text, no repo)
  readonly noTools?: boolean
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
  // honours RunOptions.readOnly; callers fall back to Claude for engines that can't
  readonly readOnly?: boolean
  // honours RunOptions.noTools
  readonly noTools?: boolean
  run(opts: RunOptions): Promise<RunResult>
  health(): Promise<EngineHealth>
}
