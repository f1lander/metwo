import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

// Agents never push: every push URL is rewritten to a scheme git can't reach. The daemon's own
// pushes run through shell.ts without this. Holds for every engine, whatever its flags.
const NO_PUSH: Record<string, string> = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'url.metwo-no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_0: 'https://',
  GIT_CONFIG_KEY_1: 'url.metwo-no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_1: 'git@',
  GIT_CONFIG_KEY_2: 'url.metwo-no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_2: 'ssh://',
}

// Agents read GitHub but never publish: a `gh` first on their PATH refuses the commands that
// write (PRs, comments, issues, releases, API writes) and passes the rest to the real gh.
// Covers every engine; Claude lanes also have the same list as deny rules.
let agentBin: string | null | undefined
function agentPath(base: string | undefined): string | undefined {
  if (agentBin === undefined) {
    agentBin = null
    try {
      const real = execFileSync('/bin/sh', ['-c', 'command -v gh'], { env: process.env }).toString().trim()
      if (real) {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'metwo-agent-bin-'))
        writeFileSync(path.join(dir, 'gh'), GH_GUARD.replace('__REAL__', real), { mode: 0o755 })
        agentBin = dir
      }
    } catch {
      agentBin = null
    }
  }
  return agentBin ? `${agentBin}${path.delimiter}${base ?? ''}` : base
}

const GH_GUARD = `#!/bin/sh
block() { echo "mevo: 'gh $*' is blocked for agents; the daemon publishes after the owner reviews" >&2; exit 1; }
case "$1" in
  pr) case "$2" in create|comment|edit|merge|ready|review|close|reopen|lock|unlock) block "$@" ;; esac ;;
  issue) case "$2" in create|comment|edit|close|reopen|delete|transfer|lock|unlock|pin|unpin|develop) block "$@" ;; esac ;;
  release|repo|secret|variable|auth|gist|ssh-key|gpg-key|label|workflow|ruleset|cache) block "$@" ;;
  api)
    for a in "$@"; do
      case "$a" in -f|-F|--field|--raw-field|--input|-f*|-F*|--field=*|--raw-field=*|--input=*) block "$@" ;; esac
    done
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-X" ] || [ "$prev" = "--method" ]; then [ "$a" = "GET" ] || [ "$a" = "get" ] || block "$@"; fi
      case "$a" in --method=*) [ "$a" = "--method=GET" ] || block "$@" ;; -X?*) [ "$a" = "-XGET" ] || block "$@" ;; esac
      prev="$a"
    done ;;
esac
exec "__REAL__" "$@"
`

// On macOS every agent runs under sandbox-exec with your secrets unreadable: SSH, cloud and
// registry credentials, browser profiles, and mevo's own .env and data (tokens, the signed-in
// GitHub browser). Everything else works as before. Set once at startup by setAgentSandbox;
// a profile that fails its self-test is dropped (logged) rather than breaking every lane.
let sandboxProfile: string | null = null
export function sandboxProfileFor(deny: readonly string[]): string {
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  // an existing file by its exact path; folders (or paths not there yet) with everything under them
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const rules = deny.map((p) => (isFile(p) ? `(literal ${quote(p)})` : `(subpath ${quote(p)})`)).join(' ')
  return `(version 1) (allow default) (deny file-read* file-write* ${rules})`
}

export function setAgentSandbox(deny: readonly string[]): string {
  if (process.platform !== 'darwin' || deny.length === 0) return 'off (not macOS)'
  const profile = sandboxProfileFor(deny)
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { timeout: 10_000 })
    sandboxProfile = profile
    return `on: ${deny.length} paths hidden from agents`
  } catch (error) {
    sandboxProfile = null
    return `off: sandbox-exec failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
  }
}

// Spawns a CLI that prints one JSON object per line, appends every line to the log file and
// hands each parsed object to `onJson`. Non-JSON lines are logged and ignored.
// The CLI gets its own process group, so a stop also takes down the dev servers and browsers it started.
export function streamJson(
  cmd: string,
  args: readonly string[],
  cwd: string,
  logFile: string,
  onJson: (obj: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(logFile), { recursive: true })
    const log = createWriteStream(logFile, { flags: 'a' })
    log.write(`[mevo] ${new Date().toISOString()} ${cmd} ${args.filter((a) => a.length < 200).join(' ')}\n`)
    const [bin, argv] = sandboxProfile ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile, cmd, ...args]] : [cmd, [...args]]
    const child = spawn(bin, argv, { cwd, env: { ...env, ...NO_PUSH, ...(agentPath(env.PATH) ? { PATH: agentPath(env.PATH) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const stop = () => {
      log.write(`[mevo] ${new Date().toISOString()} stopped by the operator\n`)
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 8000).unref()
    }
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    let stderr = ''
    let settled = false
    let finalAt = 0
    let cutAfterFinal = false
    let finalTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(finalTimer)
      signal?.removeEventListener('abort', stop)
      log.end()
      const exitCode = cutAfterFinal ? 0 : (code ?? -1)
      resolve({ exitCode, stderr: stderr.trim().split('\n').slice(-8).join('\n') })
    }
    // A dev server or watcher the agent left running can hold the output open after the CLI is
    // done, and then "close" never comes. Once the CLI has exited, or has printed its final result
    // and sits there, stop what it left behind and finish the run.
    const cut = (why: string) => {
      if (settled) return
      log.write(`[mevo] ${new Date().toISOString()} ${why}; stopping what it left running\n`)
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      log.write(`${line}\n`)
      try {
        const obj = JSON.parse(line) as unknown
        if (obj && typeof obj === 'object') {
          onJson(obj as Record<string, unknown>)
          if ((obj as Record<string, unknown>).type === 'result' && !finalAt) {
            finalAt = Date.now()
            finalTimer = setTimeout(() => {
              cutAfterFinal = true
              cut('the CLI printed its result but did not exit within a minute')
              setTimeout(() => finish(0), 6000).unref()
            }, FINAL_GRACE_MS)
            finalTimer.unref()
          }
        }
      } catch {
        // plain text progress some CLIs print; the log keeps it
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
      log.write(`[stderr] ${d.toString()}`)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(finalTimer)
      setTimeout(() => {
        if (settled) return
        cut(`the CLI exited (${code ?? 'signal'}) but its output stayed open`)
        finish(code)
      }, EXIT_GRACE_MS).unref()
    })
    child.on('close', (code) => finish(code))
  })
}

// how long to wait for the output to close once the CLI has exited, and for the CLI to exit
// once it has printed its final result
const EXIT_GRACE_MS = Number(process.env.METWO_EXIT_GRACE_MS ?? 5000)
const FINAL_GRACE_MS = Number(process.env.METWO_FINAL_GRACE_MS ?? 60_000)

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, sig)
  } catch {
    // already gone
  }
}

// Runs a short command and returns stdout, or null when it is missing or fails.
export function probe(cmd: string, args: readonly string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, out: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out: out.trim() })
    })
  })
}

// One readable line per tool call, shared by every engine so the live log reads the same.
export function toolLine(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const short = (p: string) => p.replace(/^.*\/\.worktrees\/[^/]+\//, '').replace(/^.*\/[\w.-]*wiki\//i, 'wiki/')
  const target =
    str('description') ||
    ((str('file_path') || str('path')) && short(str('file_path') || str('path'))) ||
    (str('pattern') && `${str('pattern')}${str('path') ? ` in ${short(str('path'))}` : ''}`) ||
    str('command') ||
    str('url') ||
    str('query') ||
    ''
  const tool = name.replace(/^mcp__playwright__(browser_)?/, 'pw:').replace(/^mcp__/, '')
  return `${tool}  ${target.split('\n')[0]?.slice(0, 160) ?? ''}`.trim()
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
