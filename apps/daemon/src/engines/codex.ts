import { obj, probe, str, num, streamJson, toolLine } from './stream.js'
import type { Effort, Engine, RunOptions, RunResult } from './types.js'

// Codex reasons at most "high"; max maps there.
const reasoning = (e: Effort) => (e === 'max' ? 'high' : e)

// OpenAI Codex CLI: `codex exec --json`. danger-full-access because lanes need the network
// (installs, dev server, browser) the same way Claude lanes run with bypassPermissions.
export const codex: Engine = {
  id: 'codex',
  label: 'Codex',
  readOnly: true,
  async run(opts: RunOptions): Promise<RunResult> {
    const flags = ['--json', '--sandbox', opts.readOnly ? 'read-only' : 'danger-full-access', '--skip-git-repo-check', '-c', `model_reasoning_effort="${reasoning(opts.effort)}"`]
    if (opts.model) flags.push('-m', opts.model)
    const args = opts.resume ? ['exec', ...flags, 'resume', opts.resume, opts.prompt] : ['exec', ...flags, opts.prompt]
    let sessionId: string | null = opts.resume ?? null
    let text = ''
    let tokens: number | null = null
    let model: string | null = opts.model || null
    const { exitCode, stderr } = await streamJson('codex', args, opts.cwd, opts.logFile, (o) => {
      const type = str(o.type)
      if (type === 'thread.started' && str(o.thread_id)) {
        sessionId = str(o.thread_id)
        opts.onSession?.(sessionId)
      }
      if (type === 'session.created' && str(o.model)) {
        model = str(o.model)
        opts.onModel?.(model)
      }
      if (type.startsWith('item.')) {
        const item = obj(o.item)
        const kind = str(item.type) || str(item.item_type)
        if (type === 'item.completed' && (kind === 'agent_message' || kind === 'assistant_message')) {
          const t = str(item.text)
          if (t.trim()) {
            text = t
            opts.onLine?.('text', t.trim())
          }
        }
        if (type === 'item.started' && kind === 'command_execution') opts.onLine?.('tool', toolLine('Bash', { command: str(item.command) }))
        if (type === 'item.completed' && kind === 'file_change') {
          const changes = Array.isArray(item.changes) ? item.changes : []
          for (const c of changes) opts.onLine?.('tool', toolLine('Edit', { path: str(obj(c).path) }))
        }
        if (type === 'item.started' && kind === 'mcp_tool_call') opts.onLine?.('tool', toolLine(`mcp__${str(item.server)}__${str(item.tool)}`, obj(item.arguments)))
      }
      if (type === 'turn.completed') {
        const usage = obj(o.usage)
        tokens = (num(usage.input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0)
      }
      if (type === 'turn.failed' || type === 'error') text = text || str(obj(o.error).message) || str(o.message)
    }, process.env, opts.signal)
    return { sessionId, text, exitCode, costUsd: null, model, tokens, stderr }
  },
  async health() {
    const v = await probe('codex', ['--version'])
    if (!v.ok) return { installed: false, signedIn: null, version: null, detail: 'not installed: npm i -g @openai/codex' }
    const s = await probe('codex', ['login', 'status'])
    const signedIn = s.ok && !/not logged in/i.test(s.out)
    return { installed: true, signedIn, version: v.out.split('\n')[0] ?? null, detail: signedIn ? s.out.split('\n')[0] ?? 'signed in' : 'run: codex login' }
  },
}
