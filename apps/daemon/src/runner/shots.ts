import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ghLogin } from './github.js'
import { git, sh } from './shell.js'

const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const VIDEO = /\.(mp4|mov|webm)$/i

function listShots(flowDir: string): readonly string[] {
  const dir = path.join(flowDir, 'shots')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => IMAGE.test(f))
    .sort()
    .map((f) => path.join(dir, f))
}

// Screenshots then videos, each sorted by name: the order they appear in the PR.
export function listMedia(flowDir: string): readonly { readonly file: string; readonly kind: 'image' | 'video' }[] {
  const videoDir = path.join(flowDir, 'videos')
  const videos = existsSync(videoDir)
    ? readdirSync(videoDir)
        .filter((f) => VIDEO.test(f))
        .sort()
        .map((f) => ({ file: path.join(videoDir, f), kind: 'video' as const }))
    : []
  return [...listShots(flowDir).map((file) => ({ file, kind: 'image' as const })), ...videos]
}

export interface UploadedShot {
  readonly name: string
  readonly url: string
}

// The fallback when the browser upload is off or fails: GitHub has no API for PR attachments, so
// the images go to one secret gist per ticket (yours, via gh) and the PR links them by commit.
export async function uploadShots(cwd: string, ticketId: string, files: readonly string[], gistId?: string): Promise<{ gistId: string; shots: readonly UploadedShot[] }> {
  if (files.length === 0) return { gistId: gistId ?? '', shots: [] }
  const login = await ghLogin(cwd)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'metwo-gist-'))
  try {
    let id = gistId
    if (!id) {
      const readme = path.join(tmp, `${ticketId}.md`)
      writeFileSync(readme, `Screenshots for ${ticketId}, uploaded by mevo for its draft PR.\n`)
      const { stdout } = await sh('gh', ['gist', 'create', readme, '--desc', `mevo · ${ticketId} screenshots`], cwd)
      id = stdout.trim().split('\n').pop()?.split('/').pop()
      if (!id) throw new Error(`gh gist create returned no URL: ${stdout}`)
    }
    const auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
    const who = ['-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`]
    const repo = path.join(tmp, 'gist')
    await git([...auth, 'clone', '--quiet', `https://gist.github.com/${id}.git`, repo], tmp)
    const names = files.map((f) => `${ticketId}-${path.basename(f)}`)
    files.forEach((f, i) => copyFileSync(f, path.join(repo, names[i] as string)))
    await git(['add', '-A'], repo)
    const dirty = (await git(['status', '--porcelain'], repo)).length > 0
    if (dirty) {
      await git([...who, 'commit', '--quiet', '-m', `${ticketId} screenshots`], repo)
      await git([...auth, 'push', '--quiet', 'origin', 'HEAD'], repo)
    }
    const sha = await git(['rev-parse', 'HEAD'], repo)
    return {
      gistId: id,
      shots: names.map((name) => ({ name: name.slice(ticketId.length + 1), url: `https://gist.githubusercontent.com/${login}/${id}/raw/${sha}/${encodeURIComponent(name)}` })),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
