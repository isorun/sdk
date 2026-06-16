import http from 'node:http'

export interface RecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

export function createMockServer() {
  const requests: RecordedRequest[] = []
  const routes = new Map<string, { status: number; body: any; contentType?: string }>()

  function route(method: string, path: string, status: number, body: any, contentType?: string) {
    routes.set(`${method} ${path}`, { status, body, contentType })
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body })

      const key = `${req.method} ${req.url?.split('?')[0]}`
      const handler = routes.get(key)

      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      const ct = handler.contentType ?? 'application/json'
      res.writeHead(handler.status, { 'content-type': ct })
      if (ct === 'application/octet-stream') {
        const buf = Buffer.isBuffer(handler.body) ? handler.body
          : typeof handler.body === 'string' ? Buffer.from(handler.body)
          : Buffer.alloc(0)
        res.end(buf)
      } else {
        res.end(typeof handler.body === 'string' ? handler.body : JSON.stringify(handler.body))
      }
    })
  })

  function start(): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        resolve(addr.port)
      })
    })
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()))
  }

  function reset() {
    requests.length = 0
    routes.clear()
  }

  function lastRequest(): RecordedRequest {
    return requests[requests.length - 1]
  }

  return { server, requests, route, start, stop, reset, lastRequest }
}
