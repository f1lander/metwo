import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// A hand test in your own Chrome: the app runs from the worktree, and this proxy in front of it
// adds the steps panel to every page. The panel reports what happens (wallet calls, copies, the
// URL, what the current step's check sees) to /__mevo/event and reads the steps from /__mevo/state.
// No browser automation, so it works in your everyday Chrome with your MetaMask.
export interface HandProxy {
  readonly port: number
  close(): void
}

export function startHandProxy(o: { target: number; state: () => unknown; onEvent: (e: Record<string, unknown>) => void }): Promise<HandProxy> {
  const panel = () => `${readFileSync(path.join(HERE, 'human-bridge.js'), 'utf8')}\n${readFileSync(path.join(HERE, 'human-page.js'), 'utf8')}`
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/__mevo/')) return mevo(url, req, res)
    const up = http.request({ host: 'localhost', port: o.target, path: url, method: req.method, headers: { ...req.headers, host: `localhost:${o.target}`, 'accept-encoding': 'identity' } }, (r) => {
      const html = (r.headers['content-type'] ?? '').includes('text/html') && req.method !== 'HEAD'
      if (!html) {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const tag = '<script src="/__mevo/panel.js"></script>'
        const out = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (h) => `${h}${tag}`) : `${tag}${body}`
        const { 'content-length': _len, ...headers } = r.headers
        res.writeHead(r.statusCode ?? 200, headers)
        res.end(out)
      })
    })
    up.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`mevo: the app is not answering (${e.message})`)
    })
    req.pipe(up)
  })

  const mevo = (url: string, req: http.IncomingMessage, res: http.ServerResponse) => {
    const json = (v: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(v))
    }
    if (url.startsWith('/__mevo/panel.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      res.end(panel())
      return
    }
    if (url.startsWith('/__mevo/state')) return json(o.state())
    if (url.startsWith('/__mevo/event') && req.method === 'POST') {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
        if (body.length > 200_000) req.destroy()
      })
      req.on('end', () => {
        try {
          o.onEvent(JSON.parse(body) as Record<string, unknown>)
        } catch {
          // not JSON: ignored
        }
        json({ ok: true })
      })
      return
    }
    res.writeHead(404)
    res.end()
  }

  // the dev server's websocket (hot reload) goes straight through
  server.on('upgrade', (req, socket, head) => {
    // "localhost": node tries ::1 and 127.0.0.1, vite may listen on either
    const up = net.connect({ host: 'localhost', port: o.target }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${k === 'host' ? `localhost:${o.target}` : Array.isArray(v) ? v.join(', ') : v}`)]
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve({ port: typeof a === 'object' && a ? a.port : 0, close: () => server.close() })
    })
  })
}
