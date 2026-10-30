import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Ticket } from '@ticketflow/shared'

const run = promisify(execFile)

export type TerminalApp = 'auto' | 'warp' | 'iterm' | 'ghostty' | 'terminal'

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// What runs in the terminal: the lane's own Claude session when there is one and nothing is
// running on it, otherwise a fresh read-only session that starts by reading the ticket's work.
export function claudeCommand(t: Ticket, flowDir: string, base: string, busy: boolean): { command: string; resumed: boolean } {
  const own = t.sessionId && (t.sessionEngine ?? 'claude') === 'claude'
  if (own && !busy) return { command: `claude --resume ${q(t.sessionId as string)}`, resumed: true }
  const intro = path.join(flowDir, 'ASK.md')
  writeFileSync(
    intro,
    `You are helping the owner of ${t.id} (${t.title}) understand the work on this branch. Do not change anything unless they ask.
Read first: ${path.join(flowDir, 'brief.md')}, ARM-SUMMARY.md in this folder, git log and git diff origin/${base}...HEAD${t.prUrl ? `, and the PR ${t.prUrl} (gh pr view)` : ''}.
${busy ? 'A lane is still working in this worktree right now: read only, no edits, no commands that write.\n' : ''}Then say in two lines what was done and wait for their question.`,
  )
  return { command: `claude ${busy ? '--permission-mode plan ' : ''}"$(cat ${q(intro)})"`, resumed: false }
}

async function installed(app: string): Promise<boolean> {
  return existsSync(`/Applications/${app}.app`) || existsSync(path.join(os.homedir(), 'Applications', `${app}.app`))
}

// Opens your terminal in the worktree with the command running.
export async function openTerminal(cwd: string, command: string, name: string, pref: TerminalApp): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('opening a terminal is only wired up on macOS; run it yourself: cd ' + cwd + ' && ' + command)
  const app = pref !== 'auto' ? pref : (await installed('Warp')) ? 'warp' : (await installed('iTerm')) ? 'iterm' : (await installed('Ghostty')) ? 'ghostty' : 'terminal'
  const line = `cd ${q(cwd)} && ${command}`
  if (app === 'warp') {
    // Warp runs startup commands only from a tab config; one file per ticket, rewritten each time
    const dir = path.join(os.homedir(), '.warp', 'tab_configs')
    mkdirSync(dir, { recursive: true })
    const stem = `metwo_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
    writeFileSync(path.join(dir, `${stem}.toml`), `name = ${JSON.stringify(`metwo ${name}`)}\ntitle = ${JSON.stringify(name)}\ncolor = "magenta"\n\n[[panes]]\nid = "main"\ntype = "terminal"\ndirectory = ${JSON.stringify(cwd)}\ncommands = [${JSON.stringify(command)}]\n`)
    await run('open', [`warp://tab_config/${stem}`])
    return 'Warp'
  }
  if (app === 'iterm') {
    await run('osascript', ['-e', `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text ${JSON.stringify(line)}\nend tell`])
    return 'iTerm'
  }
  if (app === 'ghostty') {
    await run('open', ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', process.env.SHELL || '/bin/zsh', '-lc', command])
    return 'Ghostty'
  }
  await run('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(line)}\nend tell`])
  return 'Terminal'
}
