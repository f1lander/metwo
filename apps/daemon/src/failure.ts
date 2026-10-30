import { existsSync, readFileSync } from 'node:fs'
import type { Failure } from '@ticketflow/shared'

interface LaneResultLine {
  readonly type?: string
  readonly error?: string
  readonly result?: unknown
  readonly subtype?: string
  readonly terminal_reason?: string
  readonly api_error_status?: number | null
}

// Last `result` and any assistant `error` in the stream-json log: that is where Claude Code
// says why a headless turn ended (auth, limits, max turns, API errors).
function laneSignals(logFile: string | undefined): { readonly error: string; readonly result: string; readonly reason: string } {
  if (!logFile || !existsSync(logFile)) return { error: '', result: '', reason: '' }
  const tail = readFileSync(logFile, 'utf8').split('\n').slice(-60)
  let error = ''
  let result = ''
  let reason = ''
  for (const raw of tail) {
    if (raw.startsWith('[stderr]')) {
      error ||= raw.slice(9, 400)
      continue
    }
    let line: LaneResultLine
    try {
      line = JSON.parse(raw) as LaneResultLine
    } catch {
      continue
    }
    if (line.error) error = line.error
    if (line.type === 'result') {
      result = typeof line.result === 'string' ? line.result : ''
      reason = line.terminal_reason ?? line.subtype ?? ''
    }
  }
  return { error, result, reason }
}

const has = (text: string, ...needles: readonly string[]) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()))

export function explainFailure(message: string, logFile?: string): Failure {
  const lane = laneSignals(logFile)
  const all = `${message}\n${lane.error}\n${lane.result}\n${lane.reason}`

  if (has(all, 'authentication_failed', 'oauth session expired', 'not logged in', 'invalid api key', 'please run /login')) {
    return { code: 'claude_auth', title: 'Claude login expired', detail: lane.result || lane.error || message, hint: 'Run `claude login` on the Mac, then retry.', retryable: true }
  }
  if (has(all, 'rate_limit', 'usage limit', 'quota', 'overloaded', '529', 'too many requests')) {
    return { code: 'claude_limit', title: 'Claude usage limit or overload', detail: lane.result || lane.error, hint: 'Wait for the limit to reset, or retry with a smaller lane.', retryable: true }
  }
  if (has(all, 'max_turns', 'max turns')) {
    return { code: 'max_turns', title: 'Lane ran out of turns', detail: lane.result, hint: 'The work is in the worktree. Retry with full, or split the ticket.', retryable: true }
  }
  if (has(all, 'spawn claude enoent', 'command not found: claude')) {
    return { code: 'claude_missing', title: 'claude CLI not found', detail: message, hint: 'The daemon was started from a shell without claude on PATH. Start it from a login shell.', retryable: true }
  }
  if (has(message, 'daemon restarted mid-run')) {
    return { code: 'daemon_restart', title: 'Daemon restarted mid-run', detail: 'The lane was killed when the daemon stopped. Everything it did is still in the worktree.', hint: 'Retry to start over, or open the worktree and keep going by hand.', retryable: true }
  }
  if (has(message, 'uncommitted changes and no commits')) {
    return { code: 'uncommitted', title: 'Lane edited files but did not commit', detail: message, hint: 'Open the worktree and check the diff; retry if it looks wrong.', retryable: true }
  }
  if (has(all, 'already exists') && has(all, 'worktree')) {
    return { code: 'git_worktree', title: 'Worktree or branch conflict', detail: message, hint: 'A branch or worktree with that name exists. Remove it (git worktree remove) and retry.', retryable: true }
  }
  if (has(all, 'could not read from remote', 'permission denied (publickey)', 'authentication failed for')) {
    return { code: 'git_auth', title: 'Git cannot reach GitHub', detail: message, hint: 'Check `gh auth status` and your git credentials on the Mac.', retryable: true }
  }
  if (has(all, 'rejected', 'non-fast-forward', 'failed to push')) {
    return { code: 'push_rejected', title: 'Push rejected', detail: message, hint: 'The remote branch moved. Pull or rebase in the worktree, then push again.', retryable: true }
  }
  if (has(all, 'gh auth login', 'gh: not logged', 'http 401')) {
    return { code: 'gh_auth', title: 'GitHub CLI not authenticated', detail: message, hint: 'Run `gh auth login` on the Mac.', retryable: true }
  }
  if (has(all, 'fetch', 'enotfound', 'econnreset', 'etimedout', 'network')) {
    return { code: 'network', title: 'Network error', detail: message, hint: 'Check the connection and retry.', retryable: true }
  }
  if (has(message, 'claude exited')) {
    return { code: 'lane_crash', title: 'Lane stopped unexpectedly', detail: lane.result || lane.error || message, hint: 'See the lane log for the last thing it did, then retry.', retryable: true }
  }
  return { code: 'unknown', title: 'Something went wrong', detail: message, hint: 'See the daemon output and the lane log.', retryable: true }
}
