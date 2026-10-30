import { spawn } from 'node:child_process'
import type { DiffFile, TicketDiff } from '@ticketflow/shared'
import { git } from './shell.js'

const MAX_LINES = 1500

// Everything the branch changes against its base, uncommitted work included,
// so the board shows exactly what a push would (plus what is still loose).
export async function ticketDiff(worktree: string, baseBranch: string): Promise<TicketDiff> {
  const base = await git(['merge-base', `origin/${baseBranch}`, 'HEAD'], worktree)
  const raw = await git(['diff', '--no-color', '--find-renames', base], worktree)
  const uncommitted = (await git(['status', '--porcelain'], worktree)).length > 0
  const files = parseDiff(raw)
  return {
    base: base.slice(0, 8),
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    uncommitted,
  }
}

function parseDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return []
  return raw
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const lines = chunk.split('\n')
      const header = lines[0] ?? ''
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header)
      let path = m?.[2] ?? header
      let oldPath: string | undefined
      let status: DiffFile['status'] = 'modified'
      for (const line of lines.slice(1, 6)) {
        if (line.startsWith('new file')) status = 'added'
        else if (line.startsWith('deleted file')) status = 'deleted'
        else if (line.startsWith('rename from ')) {
          status = 'renamed'
          oldPath = line.slice('rename from '.length)
        } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length)
      }
      const hunkStart = lines.findIndex((l) => l.startsWith('@@'))
      const body = hunkStart === -1 ? [] : lines.slice(hunkStart)
      let added = 0
      let removed = 0
      for (const l of body) {
        if (l.startsWith('+')) added++
        else if (l.startsWith('-')) removed++
      }
      const truncated = body.length > MAX_LINES
      return {
        path,
        ...(oldPath ? { oldPath } : {}),
        status,
        added,
        removed,
        binary: chunk.includes('\nBinary files '),
        patch: (truncated ? body.slice(0, MAX_LINES) : body).join('\n').trimEnd(),
        truncated,
      }
    })
}

// Tries each editor CLI, then the macOS app of the same name. Detached: the editor outlives us.
export async function openInEditor(target: string, editors: readonly string[]): Promise<string> {
  const apps: Record<string, string> = { cursor: 'Cursor', code: 'Visual Studio Code', zed: 'Zed', windsurf: 'Windsurf' }
  const attempts: [string, string[], string][] = [
    ...editors.map((e): [string, string[], string] => [e, [target], e]),
    ...(process.platform === 'darwin' ? editors.filter((e) => apps[e]).map((e): [string, string[], string] => ['open', ['-a', apps[e] as string, target], apps[e] as string]) : []),
  ]
  for (const [cmd, args, label] of attempts) {
    if (await launch(cmd, args)) return label
  }
  throw new Error(`no editor found (tried ${editors.join(', ')}); set pipeline.editors in the config`)
}

function launch(cmd: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    // `open -a Missing` exits 1 quickly; a CLI that launched exits 0 or keeps running
    child.once('exit', (code) => resolve(code === 0))
    setTimeout(() => resolve(true), 1500)
    child.unref()
  })
}
