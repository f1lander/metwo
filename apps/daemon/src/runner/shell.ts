import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
}

export async function sh(cmd: string, args: readonly string[], cwd: string, timeoutMs = 0, signal?: AbortSignal): Promise<ShellResult> {
  const { stdout, stderr } = await execFileAsync(cmd, [...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
    timeout: timeoutMs,
    ...(signal ? { signal } : {}),
  })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

export async function git(args: readonly string[], cwd: string): Promise<string> {
  return (await sh('git', args, cwd)).stdout
}

// Like sh, with `input` written to stdin (a JSON body for gh api --input -).
export function shInput(cmd: string, args: readonly string[], cwd: string, input: string): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, [...args], { cwd, env: process.env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.stdin?.end(input)
  })
}
