import { obj, probe, str, num, streamJson, toolLine } from './stream.js'
import type { Engine, RunOptions, RunResult } from './types.js'

// Claude Code: `claude -p` with stream-json. CLAUDE_CODE_EFFORT_LEVEL is stripped because, when
// set, it silently overrides --effort.
// Lanes run without prompts, but never publish: pushing, PRs, comments and the GitHub API are
// the daemon's job, after you review. Deny rules hold even in bypassPermissions.
export const LANE_DENY = [
  'Bash(git push:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr close:*)',
  'Bash(gh issue:*)',
  'Bash(gh api:*)',
  'Bash(gh release:*)',
  'Bash(gh repo:*)',
  'Bash(gh secret:*)',
  'Bash(gh auth:*)',
  'Bash(gh gist:*)',
]
const READ_ONLY = ['Read', 'Grep', 'Glob', 'LS']
const GIT_READ = ['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)', 'Bash(git status:*)']

export const claude: Engine = {
  id: 'claude',
  label: 'Claude Code',
  readOnly: true,
  noTools: true,
  async run(opts: RunOptions): Promise<RunResult> {
    const perms = opts.noTools ? ['--permission-mode', 'default', '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Read', 'Grep', 'Glob', 'LS'] : opts.readOnly ? ['--permission-mode', 'default', '--allowedTools', ...READ_ONLY, ...(opts.gitRead ? GIT_READ : [])] : ['--permission-mode', 'bypassPermissions', '--disallowedTools', ...LANE_DENY]
    const args = ['-p', opts.prompt, ...perms, '--output-format', 'stream-json', '--verbose', '--effort', opts.effort]
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
