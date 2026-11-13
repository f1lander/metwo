import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { sh } from './shell.js'

export interface Segment {
  readonly start: number
  readonly end: number
}

// The parts of the run worth watching: each step from just before it starts to just after it
// ends, merged where they touch. The waits between steps (page loads, mevo's checks) drop out.
export function segments(steps: readonly Segment[], pad = { before: 0.2, after: 0.8 }): Segment[] {
  const out: Segment[] = []
  for (const s of steps) {
    if (!(s.end > s.start)) continue
    const seg = { start: Math.max(0, s.start - pad.before), end: s.end + pad.after }
    const last = out.at(-1)
    if (last && seg.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, seg.end) }
    else out.push(seg)
  }
  return out
}

// The speed that keeps the clip at most `max` seconds, never slower than asked
export function speedFor(segs: readonly Segment[], asked: number, max = 30): number {
  const total = segs.reduce((n, s) => n + (s.end - s.start), 0)
  return Math.min(4, Math.max(asked, total / max))
}

export function cutFilter(segs: readonly Segment[], speed: number): string {
  const parts = segs.map((s, i) => `[0:v]trim=start=${s.start.toFixed(2)}:end=${s.end.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`)
  const joined = segs.length > 1 ? `${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[c];[c]` : '[v0]'
  return `${parts.join(';')};${joined}setpts=PTS/${speed},scale=1280:-2[out]`
}

// the app started from Finder has a short PATH: look where Homebrew puts it too
function ffmpeg(): string {
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => existsSync(p)) ?? 'ffmpeg'
}

// The run's video cut to its steps and sped up, as an mp4 for the PR. Without ffmpeg (or when it
// fails) the raw video is kept and the reason returned.
export async function cutClip(input: string, output: string, steps: readonly Segment[], asked: number): Promise<{ file: string; speed: number; seconds: number } | { file: string; error: string }> {
  mkdirSync(path.dirname(output), { recursive: true })
  const raw = output.replace(/\.mp4$/, '.webm')
  const segs = segments(steps)
  if (!segs.length) {
    copyFileSync(input, raw)
    return { file: raw, error: 'no step had a duration' }
  }
  const speed = speedFor(segs, asked)
  try {
    await sh(ffmpeg(), ['-y', '-loglevel', 'error', '-i', input, '-filter_complex', cutFilter(segs, speed), '-map', '[out]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '30', '-movflags', '+faststart', output], path.dirname(output), 180_000)
    if (!existsSync(output) || statSync(output).size === 0) throw new Error('ffmpeg wrote nothing')
    rmSync(raw, { force: true })
    return { file: output, speed, seconds: Math.round(segs.reduce((n, s) => n + (s.end - s.start), 0) / speed) }
  } catch (error) {
    rmSync(output, { force: true })
    try {
      copyFileSync(input, raw)
    } catch {
      // nothing to keep
    }
    const e = error as { stderr?: string; message?: string; code?: string }
    return { file: raw, error: e.code === 'ENOENT' ? 'ffmpeg is not installed' : (e.stderr || e.message || 'ffmpeg failed').split('\n').slice(-2).join(' ').slice(0, 300) }
  }
}
