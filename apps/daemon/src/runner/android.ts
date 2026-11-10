import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type AndroidDevice, AnnexB, type CheckState, nalType } from '@ticketflow/shared'

type Info = Partial<Pick<AndroidDevice, 'android' | 'chrome' | 'width' | 'height' | 'model'>>
type AndroidHealth = CheckState & { adb: string | null; devices: AndroidDevice[] }

function run(bin: string, args: readonly string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))))
  })
}

export function findAdb(): string | null {
  const home = os.homedir()
  const candidates = [
    ...(process.env.ADB ? [process.env.ADB] : []),
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'adb')),
    ...[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(home, 'Library', 'Android', 'sdk'), path.join(home, 'Android', 'Sdk')].filter(Boolean).map((d) => path.join(d as string, 'platform-tools', 'adb')),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

export function parseDevices(text: string): { serial: string; state: AndroidDevice['state']; model: string; usb: boolean }[] {
  return text
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial = '', state = '', ...rest] = l.split(/\s+/)
      const kv = Object.fromEntries(rest.filter((r) => r.includes(':')).map((r) => r.split(':', 2) as [string, string]))
      const known = state === 'device' || state === 'unauthorized' ? state : 'offline'
      // wireless debugging shows as ip:port or an mDNS name
      const usb = !/:\d+$/.test(serial) && !serial.includes('._adb-tls-connect.')
      return { serial, state: known as AndroidDevice['state'], model: (kv.model ?? kv.device ?? serial).replace(/_/g, ' '), usb }
    })
    .filter((d) => d.serial)
}

// The phones adb sees, polled every few seconds; the details of each are read once.
export class AndroidDevices {
  adb: string | null = null
  private devices: AndroidDevice[] = []
  private info = new Map<string, Info>()
  private last: AndroidHealth = { ok: null, detail: 'not checked yet', at: null, adb: null, devices: [] }
  private timer: NodeJS.Timeout | null = null
  private readonly screens = new Map<string, Screen>()

  start(everyMs = 5000): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), everyMs)
    this.timer.unref()
  }

  get health(): AndroidHealth {
    return this.last
  }

  list(): readonly AndroidDevice[] {
    return this.devices
  }

  get(serial: string): AndroidDevice | undefined {
    return this.devices.find((d) => d.serial === serial && d.state === 'device')
  }

  async poll(): Promise<void> {
    this.adb ??= findAdb()
    const at = new Date().toISOString()
    if (!this.adb) {
      this.devices = []
      this.last = { ok: null, detail: 'adb not installed (brew install android-platform-tools)', at, adb: null, devices: [] }
      return
    }
    try {
      const raw = parseDevices(await run(this.adb, ['devices', '-l']))
      const next: AndroidDevice[] = []
      for (const d of raw) {
        if (d.state === 'device' && !this.info.has(d.serial)) this.info.set(d.serial, await this.details(d.serial).catch((): Info => ({})))
        const i: Info = this.info.get(d.serial) ?? {}
        next.push({ serial: d.serial, state: d.state, transport: d.usb ? 'usb' : 'wifi', ...i, model: i.model ?? d.model })
      }
      for (const s of [...this.info.keys()]) if (!raw.some((d) => d.serial === s && d.state === 'device')) this.info.delete(s)
      this.devices = next
      const ready = next.filter((d) => d.state === 'device')
      const waiting = next.find((d) => d.state === 'unauthorized')
      this.last = {
        ok: ready.length ? true : waiting ? false : null,
        detail: ready.length ? ready.map((d) => `${d.model} · ${d.transport}`).join(', ') : waiting ? `${waiting.model}: accept the USB debugging prompt on the phone` : 'no phone connected',
        at,
        adb: this.adb,
        devices: next,
      }
    } catch (error) {
      this.last = { ok: false, detail: `adb devices failed: ${(error as Error).message.split('\n')[0]}`, at, adb: this.adb, devices: [] }
    }
  }

  private async details(serial: string): Promise<Info> {
    const sh = (cmd: string) => this.shell(serial, cmd).catch(() => '')
    const [android, model, size, chrome] = await Promise.all([sh('getprop ro.build.version.release'), sh('getprop ro.product.model'), sh('wm size'), sh('dumpsys package com.android.chrome | grep -m1 versionName')])
    const m = /(\d+)x(\d+)\s*$/m.exec(size.split('\n').filter(Boolean).at(-1) ?? '')
    const w = Number(m?.[1])
    const h = Number(m?.[2])
    return {
      ...(android.trim() ? { android: android.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(w && h ? { width: Math.min(w, h), height: Math.max(w, h) } : {}),
      ...(/versionName=(\d+)/.exec(chrome)?.[1] ? { chrome: /versionName=(\d+)/.exec(chrome)?.[1] as string } : {}),
    }
  }

  shell(serial: string, cmd: string): Promise<string> {
    if (!this.adb) return Promise.reject(new Error('adb is not installed'))
    return run(this.adb, ['-s', serial, 'shell', cmd])
  }

  adbRun(serial: string, args: readonly string[]): Promise<string> {
    if (!this.adb) return Promise.reject(new Error('adb is not installed'))
    return run(this.adb, ['-s', serial, ...args])
  }

  // the phone's localhost:port is the Mac's, over USB or wifi adb
  async reverse(serial: string, ports: readonly number[]): Promise<void> {
    for (const p of ports) await this.adbRun(serial, ['reverse', `tcp:${p}`, `tcp:${p}`])
  }

  async unreverse(serial: string, ports: readonly number[]): Promise<void> {
    for (const p of ports) await this.adbRun(serial, ['reverse', '--remove', `tcp:${p}`]).catch(() => undefined)
  }

  // A tap, a swipe or a key from the mirror. x and y are 0..1 of the screen.
  async input(serial: string, e: { type: 'tap'; x: number; y: number } | { type: 'swipe'; x: number; y: number; x2: number; y2: number; ms?: number } | { type: 'key'; key: 'back' | 'home' | 'apps' }): Promise<void> {
    const d = this.get(serial)
    if (!d) throw new Error(`no phone ${serial}`)
    const W = d.width ?? 1080
    const H = d.height ?? 2400
    const px = (v: number, max: number) => Math.round(Math.min(1, Math.max(0, v)) * (max - 1))
    if (e.type === 'tap') await this.shell(serial, `input tap ${px(e.x, W)} ${px(e.y, H)}`)
    else if (e.type === 'swipe') await this.shell(serial, `input swipe ${px(e.x, W)} ${px(e.y, H)} ${px(e.x2, W)} ${px(e.y2, H)} ${Math.round(Math.min(2000, Math.max(50, e.ms ?? 250)))}`)
    else await this.shell(serial, `input keyevent ${{ back: 4, home: 3, apps: 187 }[e.key]}`)
  }

  screen(serial: string): Screen {
    let s = this.screens.get(serial)
    if (!s) {
      const d = this.get(serial)
      s = new Screen(this.adb as string, serial, d?.width, d?.height)
      this.screens.set(serial, s)
    }
    return s
  }

  // The phone's own recording of the whole screen (keyboard and all), in parts of up to 3
  // minutes. stop() ends it and pulls the parts into dir.
  record(serial: string, tag: string): { stop: (dir: string) => Promise<string[]> } {
    let on = true
    let n = 0
    let child: ChildProcess | null = null
    const next = () => {
      if (!on || !this.adb) return
      n++
      child = spawn(this.adb, ['-s', serial, 'shell', `screenrecord --bit-rate 6000000 /sdcard/mevo-${tag}-${n}.mp4`], { stdio: 'ignore' })
      child.on('exit', () => setTimeout(next, 200))
    }
    next()
    return {
      stop: async (dir) => {
        on = false
        await this.shell(serial, `pkill -INT -f mevo-${tag}`).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 1500))
        child?.kill()
        const files = (await this.shell(serial, `ls /sdcard/mevo-${tag}-*.mp4`).catch(() => ''))
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.endsWith('.mp4'))
          .sort((a, b) => Number(/-(\d+)\.mp4$/.exec(a)?.[1]) - Number(/-(\d+)\.mp4$/.exec(b)?.[1]))
        const local: string[] = []
        for (const f of files) {
          const to = path.join(dir, `screen-${local.length + 1}.mp4`)
          await this.adbRun(serial, ['pull', f, to]).then(() => local.push(to), () => undefined)
          await this.shell(serial, `rm -f ${f}`).catch(() => undefined)
        }
        return local
      },
    }
  }

  stopAll(): void {
    for (const s of this.screens.values()) s.close()
    this.screens.clear()
  }
}

// One live H.264 stream of a phone's screen, shared by every viewer. It runs while someone
// watches; a new viewer gets the last keyframe and what followed so it can draw at once.
export class Screen {
  private child: ChildProcess | null = null
  private readonly viewers = new Set<(b: Uint8Array) => void>()
  private gop: Uint8Array[] = []
  private gopBytes = 0
  private closed = false

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly width?: number,
    private readonly height?: number,
  ) {}

  watch(send: (b: Uint8Array) => void): () => void {
    for (const nal of this.gop) send(nal)
    this.viewers.add(send)
    this.closed = false
    if (!this.child) this.spawn()
    return () => {
      this.viewers.delete(send)
      if (!this.viewers.size) this.stop()
    }
  }

  private size(): string[] {
    if (!this.width || !this.height) return []
    const w = Math.min(720, this.width)
    const h = Math.round((w * this.height) / this.width / 16) * 16
    return ['--size', `${w}x${h}`]
  }

  private spawn(): void {
    const parser = new AnnexB()
    const child = spawn(this.adb, ['-s', this.serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', '4000000', ...this.size(), '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child
    child.stdout?.on('data', (b: Buffer) => {
      for (const nal of parser.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) {
        // an SPS starts a new keyframe; a long run without one restarts the encoder
        if (nalType(nal) === 7) {
          this.gop = []
          this.gopBytes = 0
        }
        this.gop.push(nal)
        this.gopBytes += nal.length
        for (const v of this.viewers) v(nal)
        if (this.gopBytes > 24 * 1024 * 1024) child.kill()
      }
    })
    // screenrecord stops itself after 3 minutes
    child.on('exit', () => {
      if (this.child === child) this.child = null
      if (!this.closed && this.viewers.size) setTimeout(() => !this.child && this.viewers.size && this.spawn(), 300)
    })
  }

  private stop(): void {
    this.closed = true
    this.child?.kill()
    this.child = null
    this.gop = []
    this.gopBytes = 0
  }

  close(): void {
    this.viewers.clear()
    this.stop()
  }
}
