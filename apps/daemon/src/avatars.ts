import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// GitHub profile pictures, fetched by the daemon and kept on disk for a day, so the app shows real
// avatars without the browser reaching GitHub (and they still show offline once seen).
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
const SIZES = [32, 40, 48, 64, 96] as const
const DAY = 24 * 3_600_000
const pending = new Map<string, Promise<{ bytes: Buffer; type: string } | null>>()

// By GitHub user id (what Linear stores when someone links GitHub): `id:12345`.
export async function githubAvatar(dataDir: string, login: string, want: number): Promise<{ bytes: Buffer; type: string } | null> {
  const byId = /^id:(\d{1,12})$/.exec(login)?.[1]
  if (!byId && !LOGIN.test(login)) return null
  const size = SIZES.find((s) => s >= want) ?? 96
  const name = byId ? `id-${byId}` : login.replace(/\[bot\]$/i, '').toLowerCase()
  const source = byId ? `https://avatars.githubusercontent.com/u/${byId}?s=${size}&v=4` : `https://github.com/${encodeURIComponent(name)}.png?size=${size}`
  const dir = path.join(dataDir, 'avatars')
  const file = path.join(dir, `${name}-${size}`)
  const fresh = (f: string) => existsSync(f) && Date.now() - statSync(f).mtimeMs < DAY
  if (fresh(`${file}.missing`)) return null
  if (fresh(`${file}.img`)) return { bytes: readFileSync(`${file}.img`), type: readFileSync(`${file}.type`, 'utf8') }
  const key = `${name}-${size}`
  const running = pending.get(key)
  if (running) return running
  const job = (async () => {
    mkdirSync(dir, { recursive: true })
    try {
      const res = await fetch(source, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      if (!res.ok || !/^image\/(png|jpe?g|gif|webp)$/.test(type)) {
        writeFileSync(`${file}.missing`, String(res.status))
        return null
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > 1_000_000) return null
      writeFileSync(`${file}.img`, bytes)
      writeFileSync(`${file}.type`, type)
      return { bytes, type }
    } catch {
      // offline: serve yesterday's copy when there is one
      return existsSync(`${file}.img`) ? { bytes: readFileSync(`${file}.img`), type: readFileSync(`${file}.type`, 'utf8') } : null
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, job)
  return job
}
