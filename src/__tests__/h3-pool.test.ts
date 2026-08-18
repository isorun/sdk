// Many clients against the same host must share one connection pool: opening
// h3conns handshakes per client collapses throughput under a concurrent burst.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const LB_A = '10.0.0.13'
const LB_B = '10.0.0.14'
const H3_EV_HANDSHAKE = 11

const { dnsLookup, stats } = vi.hoisted(() => ({
  dnsLookup: vi.fn(async (_host: string) => {
    await new Promise((r) => setTimeout(r, 10))
    return [
      { address: '10.0.0.13', family: 4 },
      { address: '10.0.0.14', family: 4 },
    ]
  }),
  stats: { conns: 0, dialed: [] as string[], pings: 0, shutdowns: 0 },
}))
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }))

// Feed the SDK a fake native transport through the same createRequire it uses
// to load the real one, so no test-only export has to exist on the package.
vi.mock('node:module', () => {
  class NativeWorkerClient {
    private cb: (err: unknown, ev: Array<{ eventType: number }>) => void
    constructor(_opts: unknown, cb: (err: unknown, ev: Array<{ eventType: number }>) => void) {
      stats.conns++
      this.cb = cb
    }
    connect(target: string) {
      stats.dialed.push(String(target).replace(/:\d+$/, ''))
      queueMicrotask(() => this.cb(null, [{ eventType: H3_EV_HANDSHAKE }]))
    }
    sendRequest() { return 1 }
    streamSend() {}
    ping() { stats.pings++ }
    ackEventBatch() {}
    shutdown() { stats.shutdowns++ }
  }
  const req = ((_spec: string) => ({ NativeWorkerClient })) as unknown as NodeJS.Require
  req.resolve = ((s: string) => s) as unknown as NodeJS.RequireResolve
  return { createRequire: () => req }
})

const { Isorun } = await import('../index.js')
const connsOf = (c: unknown) => (c as { h3conns: number }).h3conns
let seq = 0
const freshKey = () => `isorun_live_us_pool${seq++}`

describe('native H3 connection pool is shared across Isorun instances', () => {
  beforeEach(() => { stats.conns = 0; stats.dialed = []; stats.pings = 0; stats.shutdowns = 0 })

  it('opens h3conns connections total for many same-host clients — not h3conns per client', async () => {
    const key = freshKey()
    const N = 25
    const clients = Array.from({ length: N }, () => new Isorun({ apiKey: key, apiUrl: 'http://127.0.0.1:9' }))
    const h3conns = connsOf(clients[0])

    await Promise.all(clients.map((c) => c.connect()))

    expect(stats.conns).toBe(h3conns)
    for (const c of clients) c.close()
  })

  it('does not share a pool across different hosts or keys', async () => {
    const k1 = freshKey()
    const a = new Isorun({ apiKey: k1, apiUrl: 'http://127.0.0.1:9' })
    const b = new Isorun({ apiKey: freshKey(), apiUrl: 'http://127.0.0.1:9' })
    const c = new Isorun({ apiKey: k1, apiUrl: 'http://127.0.0.2:9' })
    await Promise.all([a.connect(), b.connect(), c.connect()])
    expect(stats.conns).toBe(3 * connsOf(a))
    a.close(); b.close(); c.close()
  })

  it('close() is idempotent — a double close does not tear down a pool still in use', async () => {
    const key = freshKey()
    const a = new Isorun({ apiKey: key, apiUrl: 'http://127.0.0.1:9' })
    const b = new Isorun({ apiKey: key, apiUrl: 'http://127.0.0.1:9' })
    await Promise.all([a.connect(), b.connect()])
    const h3conns = connsOf(a)
    expect(stats.conns).toBe(h3conns)

    a.close()
    a.close()
    expect(stats.shutdowns).toBe(0)

    b.close()
    expect(stats.shutdowns).toBe(h3conns)
  })

  it('resolves DNS once per pool under concurrent resolveHosts calls', async () => {
    dnsLookup.mockClear()
    const c = new Isorun({ apiKey: freshKey(), apiUrl: 'https://run-us.example.test' })
    const resolveHosts = (c as unknown as { resolveHosts: () => Promise<string[]> }).resolveHosts.bind(c)
    await Promise.all([resolveHosts(), resolveHosts(), resolveHosts(), resolveHosts()])

    expect(dnsLookup).toHaveBeenCalledTimes(1)
    c.close()
  })

  it('a transient DNS failure is not memoized permanently', async () => {
    dnsLookup.mockClear()
    dnsLookup.mockRejectedValueOnce(new Error('EAI_AGAIN') as never)
    const c = new Isorun({ apiKey: freshKey(), apiUrl: 'https://run-us.example.test' })
    const resolveHosts = (c as unknown as { resolveHosts: () => Promise<string[]> }).resolveHosts.bind(c)

    await expect(resolveHosts()).rejects.toThrow('EAI_AGAIN')
    await expect(resolveHosts()).resolves.toEqual([LB_A, LB_B])
    c.close()
  })

  it('spreads the pool across ALL LBs, not just one', async () => {
    const c = new Isorun({ apiKey: freshKey(), apiUrl: 'https://run-us.example.test' })
    const h3conns = connsOf(c)
    await c.connect()

    expect(stats.dialed.filter((ip) => ip === LB_A).length).toBe(h3conns / 2)
    expect(stats.dialed.filter((ip) => ip === LB_B).length).toBe(h3conns / 2)
    expect(new Set(stats.dialed)).toEqual(new Set([LB_A, LB_B]))
    c.close()
  })

  it('keepalive is per-connection and pings ONLY while a request is in flight', async () => {
    vi.useFakeTimers()
    try {
      const c = new Isorun({ apiKey: freshKey(), apiUrl: 'http://127.0.0.1:9' })
      ;(c as unknown as { h3conns: number }).h3conns = 1
      const cp = c.connect()
      await vi.advanceTimersByTimeAsync(20)
      await cp

      stats.pings = 0
      await vi.advanceTimersByTimeAsync(35_000)
      expect(stats.pings).toBe(0)

      const conn = await (c as unknown as { getH3Session: () => Promise<{ waiters: Map<number, unknown> }> }).getH3Session()
      conn.waiters.set(1, {})
      stats.pings = 0
      await vi.advanceTimersByTimeAsync(35_000)
      expect(stats.pings).toBeGreaterThanOrEqual(3)

      conn.waiters.delete(1)
      stats.pings = 0
      await vi.advanceTimersByTimeAsync(35_000)
      expect(stats.pings).toBe(0)

      c.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
