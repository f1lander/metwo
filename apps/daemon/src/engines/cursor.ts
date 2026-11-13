import { obj, probe, str, streamJson, toolLine } from './stream.js'
import type { Engine, RunOptions, RunResult } from './types.js'

const TOOL_NAMES: Record<string, string> = { readToolCall: 'Read', writeToolCall: 'Write', editToolCall: 'Edit', shellToolCall: 'Bash', grepToolCall: 'Grep', globToolCall: 'Glob', lsToolCall: 'LS' }

// Cursor Agent CLI: `agent -p --output-format stream-json --force --trust`. It runs in mevo's
// worktree; its own --worktree flag is not used. No effort setting.
export const cursor: Engine = {
  id: 'cursor',
  label: 'Cursor',
  readOnly: true,
  async run(opts: RunOptions): Promise<RunResult> {
    // read-only: no --force, so shell commands and writes are not auto-approved; no repo MCP servers
    const args = ['-p', '--output-format', 'stream-json', '--trust', ...(opts.readOnly ? [] : ['--force', '--approve-mcps'])]
    if (opts.model) args.push('--model', opts.model)
    if (opts.resume) args.push('--resume', opts.resume)
    args.push(opts.prompt)
    let sessionId: string | null = opts.resume ?? null
    let text = ''
    let model: string | null = opts.model || null
    const { exitCode, stderr } = await streamJson('agent', args, opts.cwd, opts.logFile, (o) => {
      // the init and result events carry the full chat id; others may abbreviate it
      const sid = o.type === 'system' || o.type === 'result' ? str(o.session_id) : ''
      if (sid && sid !== sessionId) {
        sessionId = sid
        opts.onSession?.(sid)
      }
      if (o.type === 'system' && o.subtype === 'init' && str(o.model)) {
        model = str(o.model)
        opts.onModel?.(model)
      }
      if (o.type === 'assistant' && !('timestamp_ms' in o)) {
        const content = obj(o.message).content
        for (const block of Array.isArray(content) ? content : []) {
          const t = str(obj(block).text).trim()
          if (t) opts.onLine?.('text', t)
        }
      }
      if (o.type === 'tool_call' && o.subtype === 'started') {
        const call = obj(o.tool_call)
        const key = Object.keys(call)[0] ?? 'tool'
        const args = obj(obj(call[key]).args)
        opts.onLine?.('tool', toolLine(TOOL_NAMES[key] ?? key, args))
      }
      if (o.type === 'result') text = str(o.result) || text
    }, process.env, opts.signal)
    return { sessionId, text, exitCode, costUsd: null, model, tokens: null, stderr }
  },
  async health() {
    const v = await probe('agent', ['--version'])
    if (!v.ok) return { installed: false, signedIn: null, version: null, detail: 'not installed: curl https://cursor.com/install -fsS | bash' }
    const s = await probe('agent', ['status'])
    const signedIn = s.ok && !/not (logged|signed) in|login required/i.test(s.out)
    return { installed: true, signedIn, version: v.out.split('\n')[0] ?? null, detail: signedIn ? s.out.split('\n')[0] ?? 'signed in' : 'run: agent login' }
  },
}
