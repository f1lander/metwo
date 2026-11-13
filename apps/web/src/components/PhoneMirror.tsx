import { AnnexB, avcCodec, nalType, startsPicture } from '@ticketflow/shared'
import { useEffect, useRef, useState } from 'react'
import { actions, screenUrl } from '../lib/api.js'

type State = 'connecting' | 'live' | 'unsupported' | 'error'

// The phone's screen, live (H.264 from adb, decoded with WebCodecs). Click to tap, drag to swipe.
export function PhoneMirror({ serial, model, width, height, className = '' }: { serial: string; model: string; width?: number | undefined; height?: number | undefined; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<State>('connecting')
  const [error, setError] = useState('')
  const down = useRef<{ x: number; y: number; t: number } | null>(null)

  useEffect(() => {
    if (typeof VideoDecoder === 'undefined') {
      setState('unsupported')
      return
    }
    const abort = new AbortController()
    let decoder: VideoDecoder | null = null
    let codec = ''
    let waitKey = true
    let ts = 0
    let prefix: Uint8Array[] = []
    const draw = (frame: VideoFrame) => {
      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (c && ctx) {
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth
          c.height = frame.displayHeight
        }
        ctx.drawImage(frame, 0, 0)
        setState('live')
      }
      frame.close()
    }
    const feed = (nal: Uint8Array) => {
      const t = nalType(nal)
      if (t === 7) {
        const next = avcCodec(nal)
        if (next !== codec || !decoder || decoder.state !== 'configured') {
          decoder?.state !== 'closed' && decoder?.close()
          decoder = new VideoDecoder({ output: draw, error: (e) => setError(e.message) })
          decoder.configure({ codec: next, optimizeForLatency: true })
          codec = next
        }
        waitKey = true
        prefix = [nal]
        return
      }
      if (!startsPicture(nal)) {
        // the PPS and SEI go with the next picture
        if (t === 8 || t === 6) prefix.push(nal)
        return
      }
      const key = t === 5
      if (!decoder || (waitKey && !key)) {
        prefix = []
        return
      }
      waitKey = false
      const parts = [...prefix, nal]
      prefix = []
      const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of parts) {
        data.set(p, o)
        o += p.length
      }
      // drop frames when the decoder falls behind, keeping the next keyframe
      if (decoder.decodeQueueSize > 8 && !key) return
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (ts += 33_333), data }))
    }
    void (async () => {
      try {
        const res = await fetch(screenUrl(serial), { signal: abort.signal })
        if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `the screen stream answered ${res.status}`)
        const parser = new AnnexB()
        const reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const nal of parser.push(value)) feed(nal)
        }
        if (!abort.signal.aborted) setState('error')
      } catch (e) {
        if (abort.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      }
    })()
    return () => {
      abort.abort()
      if (decoder && decoder.state !== 'closed') decoder.close()
    }
  }, [serial])

  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const send = (e: Parameters<typeof actions.phoneInput>[1]) => void actions.phoneInput(serial, e).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  const onUp = (e: React.PointerEvent) => {
    const from = down.current
    down.current = null
    if (!from) return
    const to = at(e)
    const far = Math.hypot(to.x - from.x, to.y - from.y) > 0.02
    send(far ? { type: 'swipe', x: from.x, y: from.y, x2: to.x, y2: to.y, ms: Math.max(80, Date.now() - from.t) } : { type: 'tap', x: to.x, y: to.y })
  }

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <div className="relative w-full overflow-hidden rounded-[22px] border-[6px] border-[#1c1d21] bg-black shadow-lg" style={{ aspectRatio: width && height ? `${width} / ${height}` : '9 / 19.5' }}>
        <canvas
          ref={canvas}
          aria-label={`${model} screen`}
          className="absolute inset-0 h-full w-full cursor-pointer touch-none object-contain"
          onPointerDown={(e) => {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            down.current = { ...at(e), t: Date.now() }
          }}
          onPointerUp={onUp}
        />
        {state !== 'live' && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted">
            {state === 'connecting' ? `Connecting to the ${model}…` : state === 'unsupported' ? 'This window cannot decode video (no WebCodecs). Open mevo in Chrome or the desktop app.' : `The screen stream stopped${error ? `: ${error}` : ''}`}
          </div>
        )}
      </div>
      <div className="flex gap-1 text-xs">
        {(['back', 'home', 'apps'] as const).map((k) => (
          <button key={k} type="button" onClick={() => send({ type: 'key', key: k })} className="rounded-md border border-line-2 px-2 py-0.5 text-muted capitalize hover:text-fg">
            {k === 'apps' ? 'Recents' : k}
          </button>
        ))}
      </div>
      {error && state === 'live' && <span className="text-[11px] text-bad">{error}</span>}
    </div>
  )
}
