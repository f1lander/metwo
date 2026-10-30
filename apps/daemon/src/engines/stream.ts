import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

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
    log.write(`[metwo] ${new Date().toISOString()} ${cmd} ${args.filter((a) => a.length < 200).join(' ')}\n`)
    const child = spawn(cmd, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const stop = () => {
      log.write(`[metwo] ${new Date().toISOString()} stopped by the operator\n`)
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 8000).unref()
    }
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    let stderr = ''
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      log.write(`${line}\n`)
      try {
        const obj = JSON.parse(line) as unknown
        if (obj && typeof obj === 'object') onJson(obj as Record<string, unknown>)
      } catch {
        // plain text progress some CLIs print; the log keeps it
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
      log.write(`[stderr] ${d.toString()}`)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      log.end()
      resolve({ exitCode: code ?? -1, stderr: stderr.trim().split('\n').slice(-8).join('\n') })
    })
  })
}

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
