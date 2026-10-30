import { obj, probe, str, num, streamJson, toolLine } from './stream.js'
import type { Engine, RunOptions, RunResult } from './types.js'

// Claude Code: `claude -p` with stream-json. CLAUDE_CODE_EFFORT_LEVEL is stripped because, when
// set, it silently overrides --effort.
export const claude: Engine = {
  id: 'claude',
  label: 'Claude Code',
  async run(opts: RunOptions): Promise<RunResult> {
    const args = ['-p', opts.prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', '--effort', opts.effort]
    if (opts.model) args.push('--model', opts.model)
    if (opts.resume) args.push('--resume', opts.resume)
    const { CLAUDE_CODE_EFFORT_LEVEL: _dropped, ...env } = process.env
    let sessionId: string | null = opts.resume ?? null
    let text = ''
    let costUsd: number | null = null
    let model: string | null = null
    let tokens: number | null = null
    const { exitCode, stderr } = await streamJson(
      'claude',
      args,
      opts.cwd,
      opts.logFile,
      (o) => {
        const sid = str(o.session_id)
        if (sid && sid !== sessionId) {
          sessionId = sid
          opts.onSession?.(sid)
        }
        if (o.type === 'system' && o.subtype === 'init' && str(o.model)) {
          model = str(o.model)
          opts.onModel?.(model)
        }
        if (o.type === 'assistant') {
          const content = obj(o.message).content
          for (const block of Array.isArray(content) ? content : []) {
            const b = obj(block)
            if (b.type === 'text' && str(b.text).trim()) opts.onLine?.('text', str(b.text).trim())
            if (b.type === 'tool_use' && str(b.name)) opts.onLine?.('tool', toolLine(str(b.name), obj(b.input)))
          }
        }
        if (o.type === 'result') {
          text = str(o.result) || text
          costUsd = num(o.total_cost_usd) ?? costUsd
          const usage = obj(o.usage)
          tokens = (num(usage.input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0) || tokens
        }
      },
      env,
      opts.signal,
    )
    return { sessionId, text, exitCode, costUsd, model, tokens, stderr }
  },
  async health() {
    const v = await probe('claude', ['--version'])
    return { installed: v.ok, signedIn: null, version: v.ok ? v.out.split('\n')[0] ?? null : null, detail: v.ok ? 'installed; sign-in shows on the first run' : 'not installed' }
  },
}
