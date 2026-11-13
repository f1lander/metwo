import { obj, probe, str, num, streamJson, toolLine } from './stream.js'
import type { Engine, RunOptions, RunResult } from './types.js'

// Lanes install, run dev servers and edit files without asking, like the other engines.
const PERMISSION = JSON.stringify({ '*': 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' })

// no tools: the answer comes from the prompt alone
const NO_TOOLS = JSON.stringify({ '*': 'deny', edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' })

// OpenCode (sst/opencode): `opencode run --format json`, any provider it is signed in to
// (OpenCode Zen free models, OpenRouter ":free" models, a ChatGPT or Copilot plan, local models).
// The model is "provider/model"; empty uses opencode's own default. No effort setting.
export const opencode: Engine = {
  id: 'opencode',
  label: 'OpenCode',
  noTools: true,
  async run(opts: RunOptions): Promise<RunResult> {
    const args = ['run', '--format', 'json']
    if (opts.model) args.push('--model', opts.model)
    if (opts.resume) args.push('--session', opts.resume)
    args.push(opts.prompt)
    let sessionId: string | null = opts.resume ?? null
    let text = ''
    let step = ''
    let cost = 0
    let tokens = 0
    const { exitCode, stderr } = await streamJson('opencode', args, opts.cwd, opts.logFile, (o) => {
      const sid = str(o.sessionID)
      if (sid && sid !== sessionId) {
        sessionId = sid
        opts.onSession?.(sid)
      }
      const part = obj(o.part)
      if (o.type === 'step_start') step = ''
      if (o.type === 'text') {
        const t = str(part.text).trim()
        if (t) {
          step = step ? `${step}\n${t}` : t
          text = step
          opts.onLine?.('text', t)
        }
      }
      if (o.type === 'tool_use') {
        const input = obj(obj(part.state).input)
        opts.onLine?.('tool', toolLine(capital(str(part.tool)), { ...input, file_path: input.filePath ?? input.file_path }))
      }
      if (o.type === 'step_finish') {
        cost += num(part.cost) ?? 0
        const t = obj(part.tokens)
        tokens += (num(t.input) ?? 0) + (num(t.output) ?? 0) + (num(t.reasoning) ?? 0)
      }
    }, { ...process.env, OPENCODE_PERMISSION: opts.noTools ? NO_TOOLS : PERMISSION }, opts.signal)
    return { sessionId, text, exitCode, costUsd: cost || null, model: opts.model || null, tokens: tokens || null, stderr }
  },
  async health() {
    const v = await probe('opencode', ['--version'])
    if (!v.ok) return { installed: false, signedIn: null, version: null, detail: 'not installed: npm i -g opencode-ai' }
    return { installed: true, signedIn: null, version: v.out.split('\n')[0] ?? null, detail: 'installed · providers: opencode auth list' }
  },
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : 'tool')
