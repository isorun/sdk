/**
 * isorun - TypeScript SDK for Isorun sandboxes.
 *
 * Create isolated Linux sandboxes, execute commands, read/write files,
 * and manage sandbox lifecycle.
 *
 * @example
 * ```ts
 * import { Isorun } from 'isorun'
 *
 * const isorun = new Isorun()
 * const sandbox = await isorun.create({ image: 'node:22-slim' })
 * const result = await sandbox.exec('node -v')
 * console.log(result.stdout) // v22.x.x
 * await sandbox.destroy()
 * ```
 *
 * @see https://isorun.ai
 * @see https://docs.isorun.ai
 */

import { Agent, request } from 'undici'

// Optional native transport, loaded lazily and best-effort: if it's absent for
// this platform the SDK uses the HTTP/2 path instead. A connect-level failure
// trips a per-client breaker that falls back to HTTP/2 for the rest of the
// client's life. This package is ESM (`type: module`), so use createRequire to
// load the optional CJS native addon.
//
// Bundle-safe base for createRequire: as ESM, import.meta.url is set. But when a
// consumer inlines this SDK into a CJS bundle (esbuild — what benchmark harnesses
// do), import.meta.url is undefined, and createRequire(undefined) THROWS at module
// load — crashing the H3 loader (and, in builds that shim it differently, silently
// dropping the client to HTTP/2). In the CJS-bundled form the `__filename` global
// exists, so use it (createRequire accepts a path string or a file URL). This keeps
// the native H3 transport loadable whether imported as ESM or bundled to CJS.
import { createRequire } from 'node:module'
// @ts-ignore -- __filename exists only in the CJS-bundled form; typeof-guarded so neither branch throws.
const _h3require = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

// Load the native HTTP/3 transport directly from our own platform-specific
// package. Each `@isorun/http-transport-*` ships a napi addon whose `.node`
// exports NativeWorkerClient — no third-party JS wrapper, so the SDK owns the
// whole H3 path and carries no external native dependency. If none matches this
// platform, the binding is absent and the SDK uses the HTTP/2 path instead.
let _binding: any = null
function loadBinding(): any {
  if (_binding !== null) return _binding
  for (const spec of [
    '@isorun/http-transport-linux-x64-gnu/transport.node',
    '@isorun/http-transport-linux-arm64-gnu/transport.node',
    '@isorun/http-transport-linux-x64-musl/transport.node',
    '@isorun/http-transport-linux-arm64-musl/transport.node',
    '@isorun/http-transport-darwin-arm64/transport.node',
  ]) {
    try {
      const b = _h3require(_h3require.resolve(spec))
      if (b && b.NativeWorkerClient) { _binding = b; return b }
    } catch { /* not this platform — try the next */ }
  }
  _binding = false
  return false
}
// Pre-load the native transport at import time. Guarded for runtimes without
// setImmediate, where the HTTP/2 path is used anyway.
if (typeof setImmediate === 'function') setImmediate(() => { try { loadBinding() } catch { /* best-effort */ } })

// H3 event type discriminants (must match the native transport's event enum).
const H3_EV_HEADERS = 3
const H3_EV_DATA = 4
const H3_EV_FINISHED = 5
const H3_EV_RESET = 6
const H3_EV_SESSION_CLOSE = 7
const H3_EV_ERROR = 10
const H3_EV_HANDSHAKE = 11

interface H3Pending {
  status: number
  chunks: Buffer[]
  gotResponse: boolean
  finish: () => void
  failTransport: () => void
}
interface H3Conn {
  client: any
  waiters: Map<number, H3Pending>
  dead: boolean
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** SDK configuration. */
export interface IsorunOptions {
  /** API key. Falls back to `ISORUN_API_KEY` env var. */
  apiKey?: string
  /** Runner endpoint override. By default the runner URL is derived from the region encoded in the API key. Only set this for self-hosted or test endpoints. */
  apiUrl?: string
}

/** Options for creating a sandbox. */
export interface CreateOptions {
  /** Container image (e.g. `node:22-slim`, `python:3.12-slim`). Default: `node:22-slim`. */
  image?: string
  /** Virtual CPUs. Default: 1. */
  vcpus?: number
  /** Memory in MiB. Default: 1024. */
  memMiB?: number
  /** Scratch disk in MiB. Default: 4096. */
  diskMiB?: number
  /** Auto-destroy timeout in seconds. Default: 300. */
  timeoutSec?: number
  /** Egress allow/deny lists. Empty arrays = unrestricted. CIDRs, hostnames, and `*.wildcards` are accepted. */
  network?: { allow?: string[]; deny?: string[] }
  /** Named egress profile (mutually exclusive with `network`). See `isorun.networkProfiles()`. */
  networkProfile?: string
  /** Credentials injected into the sandbox via the host-side credential proxy. Map service → API key. */
  credentials?: Record<string, string>
}

/** A named egress profile listing the allow/deny lists it applies. */
export interface NetworkProfile {
  name: string
  description?: string
  allow: string[]
  deny: string[]
}

/** A single entry in the sandbox audit trail. */
export interface AuditEntry {
  /** Monotonic sequence number within the log, starting at 0. */
  seq: number
  /** RFC3339 timestamp of the event. */
  timestamp: string
  sandboxId: string
  /** Event kind, e.g. "exec.start", "sandbox.created", "network.blocked". */
  event: string
  /** Event-specific payload. Never contains command output or credential values. */
  data: Record<string, unknown>
  /** Chained HMAC over this entry and the previous one ("sha256:..."). */
  hmac: string
}

/** Result of a command execution. */
export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Directory entry returned by `readdir`. */
export interface FileEntry {
  name: string
}

/** Statistics returned by `destroy`. */
export interface DestroyResult {
  status: string
  cpuMs: number
  memPeakBytes: number
  uptimeMs: number
  /** Cost of this sandbox in cents (fractional - sub-second sandboxes are sub-cent). */
  costCents: number
}

/** Sandbox metadata returned by `info`. */
export interface SandboxInfo {
  id: string
  status: string
  image: string
  vcpus: number
  memMiB: number
  diskMiB: number
  createMs: number
  createdAt: string
}

/** Snapshot metadata. Returned by `sandbox.snapshot()` and `isorun.listSnapshots()`. */
export interface Snapshot {
  id: string
  /** Source sandbox. Present on `snapshot()`; omitted by the list endpoint. */
  runId?: string
  sizeBytes: number
  createdAt: string
}

/** Live usage summary for the account. Returned by `isorun.usage()`. */
export interface UsageSummary {
  activeSandboxes: number
  historySandboxes: number
  activeCostCents: number
  historyCostCents: number
  totalCostCents: number
  cpuSeconds: number
  memSeconds: number
  /** RFC3339 timestamp the summary was computed at. */
  asOf: string
}

/** A past (destroyed) sandbox. Returned by `isorun.history()`. */
export interface SandboxHistoryEntry {
  id: string
  image: string
  vcpus: number
  memMiB: number
  createMs: number
  createdAt: string
  destroyedAt: string
  uptimeMs: number
  cpuMs: number
  memPeakBytes: number
  costCents: number
}

/**
 * Thrown for a non-2xx HTTP response from the runner. Catch it to branch on a
 * specific status (e.g. `429` capacity, `404` not-found) by code instead of
 * string-matching the message.
 *
 * @example
 * ```ts
 * try { await sandbox.exec('...') }
 * catch (e) { if (e instanceof IsorunError && e.status === 429) backoff() }
 * ```
 */
export class IsorunError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number
  /** Response body (truncated to a sane size), when one was received. */
  readonly body?: string
  constructor(status: number, message: string, body?: string) {
    super(message)
    this.name = 'IsorunError'
    this.status = status
    this.body = body
  }
}

/** Per-request options accepted by the SDK's request-issuing methods. */
export interface RequestOptions {
  /** Cancel the request via an `AbortController` / `AbortSignal`. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the region from an API key, or null if the key doesn't carry one. */
function regionFromKey(apiKey: string): string | null {
  const parts = apiKey.split('_')
  if (parts.length >= 5 && parts[0] === 'isorun' && parts[1] === 'live') {
    return parts[2]
  }
  return null
}

// ---------------------------------------------------------------------------
// Wire types: the raw snake_case JSON the runner returns. Unknown extra fields
// are ignored, so additive server changes don't break the SDK.
// ---------------------------------------------------------------------------

interface RunWire {
  id: string
  create_ms?: number
  image?: string
  status?: string
  vcpus?: number
  mem_mib?: number
  disk_mib?: number
  created_at?: string
}
interface ListRunsWire { runs?: RunWire[] }
interface ForkWire { forks?: RunWire[] }
interface ExecWire { exit_code?: number; stdout?: string; stderr?: string }
interface DestroyWire {
  status?: string
  cpu_ms?: number
  mem_peak_bytes?: number
  uptime_ms?: number
  cost_cents?: number
}
interface SnapshotWire { snapshot_id: string; run_id?: string; size_bytes?: number; created_at?: string }
interface SnapshotListItemWire { id: string; run_id?: string; size_bytes?: number; created_at?: string }
interface ListSnapshotsWire { snapshots?: SnapshotListItemWire[] }
interface UsageWire {
  active_sandboxes: number
  history_sandboxes: number
  active_cost_cents: number
  history_cost_cents: number
  total_cost_cents: number
  cpu_seconds: number
  mem_seconds: number
  as_of: string
}
interface HistoryEntryWire {
  id: string
  image?: string
  vcpus?: number
  mem_mib?: number
  create_ms?: number
  created_at?: string
  destroyed_at?: string
  uptime_ms?: number
  cpu_ms?: number
  mem_peak_bytes?: number
  cost_cents?: number
}
interface HistoryWire { sandboxes?: HistoryEntryWire[] }
interface ReaddirWire { entries?: string[] }
interface AuditWire {
  seq: number
  ts: string
  sandbox_id: string
  event: string
  data?: Record<string, unknown>
  hmac: string
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * FIFO semaphore capping concurrent in-flight requests across both transports,
 * so a large fan-out can't flood the connection or the runner's exec path.
 */
class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.max <= 0) return () => {}
    if (this.active < this.max) {
      this.active++
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }
  private release() {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

/** Isorun API client. Create sandboxes, list them, and manage lifecycle. */
export class Isorun {
  /** Resolved runner endpoint. Exposed for SDK consumers building proxy URLs. */
  readonly apiUrl: string
  private readonly apiKey: string
  private readonly dispatcher: Agent
  private readonly sem: Semaphore
  private readonly h3Enabled: boolean
  private readonly h3host: string
  private readonly h3conns: number
  private h3Sessions: any[] = []
  private h3Connecting: (Promise<any> | null)[] = []
  // Sessions still connecting; close() must be able to destroy these so a
  // pending connection doesn't keep the process alive.
  private h3Pending = new Set<any>()
  private h3rr = 0
  // The native transport's callback is unref'd, so we hold the event loop open
  // with a ref-counted timer while work is in flight, and release it when idle.
  private loopHolders = 0
  private loopTimer: ReturnType<typeof setInterval> | null = null
  private retainLoop(): void {
    if (++this.loopHolders === 1) this.loopTimer = setInterval(() => {}, 1 << 30)
  }
  private releaseLoop(): void {
    if (this.loopHolders > 0 && --this.loopHolders === 0 && this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }
  }
  private h3WarmKicked = false
  // Resolved server IP, cached. connect() takes a literal IP:port (no DNS); the
  // hostname is still used for SNI/cert verification.
  private h3ip: string | null = null
  // Tripped on a connect-level failure of the native transport. Once set,
  // requests go straight to HTTP/2 for the rest of this client's life.
  private h3Broken = false

  constructor(options: IsorunOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ISORUN_API_KEY ?? ''
    if (!this.apiKey) {
      throw new Error('Missing API key. Set apiKey in options or the ISORUN_API_KEY environment variable.')
    }

    const explicitUrl = options.apiUrl ?? process.env.ISORUN_API_URL
    let url: string
    if (explicitUrl) {
      url = explicitUrl
    } else {
      const region = regionFromKey(this.apiKey)
      if (!region) {
        throw new Error('Cannot derive runner endpoint: API key carries no region segment. Pass apiUrl explicitly or set ISORUN_API_URL.')
      }
      url = `https://run-${region}.isorun.ai`
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    this.apiUrl = url.replace(/\/$/, '')

    // Fallback transport: HTTP/2 over a pooled undici dispatcher, used whenever
    // the native transport is unavailable. Each connection multiplexes many streams.
    this.dispatcher = new Agent({
      allowH2: true,
      connections: 32,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    })

    // Cap concurrent in-flight requests so a large fan-out paces itself.
    this.sem = new Semaphore(1000)

    this.h3host = new URL(this.apiUrl).hostname
    // The native transport is preferred whenever its binding loads.
    this.h3Enabled = !!loadBinding()
    // Native transport connection pool size.
    this.h3conns = 4
    // The pool opens lazily on the first request; call `connect()` to pre-warm.
  }

  /** Close pooled connections so the process can exit cleanly. */
  close(): void {
    void this.dispatcher.close()
    // Shut down both pending and live connections so the process can exit.
    for (const c of this.h3Pending) { try { c.shutdown?.() } catch { /* ignore */ } }
    this.h3Pending.clear()
    for (const conn of this.h3Sessions) {
      try { conn?.client?.shutdown?.() } catch { /* ignore */ }
    }
    this.h3Sessions = []
    this.h3Connecting = []
  }

  /** Resolve the runner host to an IPv4 literal (cached); the binding's
   *  connect() needs an IP, not a hostname. */
  private async resolveHost(): Promise<string> {
    if (this.h3ip) return this.h3ip
    const { lookup } = await import('node:dns/promises')
    this.h3ip = (await lookup(this.h3host, { family: 4 })).address
    return this.h3ip
  }

  /** Open a pooled session lazily; requests round-robin across the pool. */
  private getH3Session(): Promise<any> {
    return this.connectIdx((this.h3rr++) % this.h3conns)
  }

  /**
   * Open the connection pool up front. Best-effort and transport-only: failures
   * are swallowed and the request path still falls back, so calling it can never
   * break a request.
   */
  async connect(): Promise<void> {
    if (!this.h3Enabled) return
    // Awaited by the caller, so hold the loop open until the pool is up.
    this.retainLoop()
    try { await this.warmPool() } finally { this.releaseLoop() }
  }

  /** Open the pool without holding the loop, so an abandoned client can still exit. */
  private warmPool(): Promise<void> {
    return Promise.all(
      Array.from({ length: this.h3conns }, (_, i) => this.connectIdx(i).catch(() => null)),
    ).then(() => {})
  }

  /** Open (or reuse) the pooled connection at a specific index. */
  private connectIdx(idx: number): Promise<H3Conn> {
    const existing = this.h3Sessions[idx]
    if (existing && !existing.dead) return Promise.resolve(existing)
    if (this.h3Connecting[idx]) return this.h3Connecting[idx]!
    const binding = loadBinding()
    if (!binding) return Promise.reject(new Error('h3 binding unavailable'))
    // Per-stream flow-control window, sized to the SDK's small (~KB) payloads.
    const streamWin = 65536
    const initialMaxData = Math.max(streamWin * 64, 4 * 1024 * 1024)
    this.h3Connecting[idx] = (async (): Promise<H3Conn> => {
      const ip = await this.resolveHost()
      return await new Promise<H3Conn>((resolve, reject) => {
        const waiters = new Map<number, H3Pending>()
        const conn: H3Conn = { client: null, waiters, dead: false }
        let onConnect: (() => void) | null = null
        // Terminal connection failure: reject every in-flight waiter as a
        // (fallback-eligible) transport error and retire this pool slot.
        const failAll = () => {
          conn.dead = true
          if (this.h3Sessions[idx] === conn) this.h3Sessions[idx] = null
          for (const [sid, p] of waiters) { waiters.delete(sid); p.failTransport() }
        }
        const client = new binding.NativeWorkerClient(
          {
            rejectUnauthorized: true,
            runtimeMode: 'portable',
            initialMaxStreamDataBidiLocal: streamWin,
            initialMaxData,
          },
          (err: any, events: any[]) => {
            if (err) return
            for (let i = 0; i < events.length; i++) {
              const ev = events[i]
              const t = ev.eventType
              if (t === H3_EV_HANDSHAKE) { if (onConnect) { onConnect(); onConnect = null } continue }
              if (t === H3_EV_SESSION_CLOSE) { failAll(); continue }
              const p = waiters.get(ev.streamId)
              if (!p) continue
              if (t === H3_EV_HEADERS) {
                p.gotResponse = true
                if (ev.headers) for (const h of ev.headers) if (h.name === ':status') p.status = parseInt(h.value, 10) || 0
                if (ev.data) p.chunks.push(ev.data)
                // fin on headers/data terminates the stream (e.g. a headers-only
                // response); a later FINISHED for an already-deleted waiter is
                // harmlessly ignored.
                if (ev.fin) { waiters.delete(ev.streamId); p.finish() }
              } else if (t === H3_EV_DATA) {
                if (ev.data) p.chunks.push(ev.data)
                if (ev.fin) { waiters.delete(ev.streamId); p.finish() }
              } else if (t === H3_EV_FINISHED) {
                waiters.delete(ev.streamId)
                p.finish()
              } else if (t === H3_EV_RESET || t === H3_EV_ERROR) {
                waiters.delete(ev.streamId)
                p.failTransport()
              }
            }
            try { client.ackEventBatch(events.length) } catch { /* shutting down */ }
          },
        )
        conn.client = client
        this.h3Pending.add(client)
        const timer = setTimeout(() => {
          this.h3Pending.delete(client)
          this.h3Connecting[idx] = null
          try { client.shutdown() } catch { /* ignore */ }
          reject(new Error('h3 connect timeout'))
        }, 10_000)
        // Connect timeout must never hold a short-lived process open.
        timer.unref?.()
        onConnect = () => {
          clearTimeout(timer)
          this.h3Pending.delete(client)
          this.h3Sessions[idx] = conn
          this.h3Connecting[idx] = null
          resolve(conn)
        }
        try {
          client.connect(`${ip}:443`, this.h3host)
        } catch (e) {
          clearTimeout(timer)
          this.h3Pending.delete(client)
          this.h3Connecting[idx] = null
          reject(e)
        }
      })
    })()
    return this.h3Connecting[idx]!
  }

  // Send a request over the native transport. A non-2xx throws an IsorunError;
  // json() must NOT retry that on the fallback, or a POST could duplicate. A
  // no-response failure throws a tagged transport error that json() falls back on.
  private async h3Request<T>(method: string, path: string, data?: string, opts: RequestOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted')
    // Hold the loop across the whole operation; the native callback is unref'd, so
    // without this a bare request could exit mid-flight.
    this.retainLoop()
    try {
      const conn = await this.getH3Session().catch((e) => { const err: any = new Error('h3 transport: ' + e?.message); err.h3transport = true; err.h3connect = true; throw err })
      return await new Promise<T>((resolve, reject) => {
      let settled = false
      let sid = -1
      let timer: ReturnType<typeof setTimeout>
      const onAbort = () => bad(opts.signal?.reason ?? new Error('aborted'))
      const cleanup = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (sid >= 0) conn.waiters.delete(sid)
      }
      const ok = (v: T) => { if (settled) return; settled = true; cleanup(); resolve(v) }
      const bad = (e: any) => { if (settled) return; settled = true; cleanup(); reject(e) }
      // Request deadline: a stalled stream can't hang the promise forever. NOT
      // tagged h3transport — a timed-out request must not silently re-fire on
      // H2 (a POST could duplicate).
      timer = setTimeout(() => bad(new Error('h3 request timeout')), 120_000)
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })

      const pending: H3Pending = {
        status: 0,
        chunks: [],
        gotResponse: false,
        finish: () => {
          // Decode once over all chunks so a multi-byte UTF-8 char split across
          // a chunk boundary is reassembled correctly.
          const text = Buffer.concat(pending.chunks).toString('utf8')
          if (pending.status >= 200 && pending.status < 300) {
            try { ok(text ? JSON.parse(text) : ({} as T)) }
            catch { bad(new IsorunError(pending.status, `invalid JSON in ${pending.status} response`, text)) }
          } else {
            bad(new IsorunError(pending.status, `HTTP ${pending.status}: ${text.slice(0, 200)}`, text))
          }
        },
        // Stream reset/error or session close. If the response had started, it's
        // a genuine mid-stream failure (don't silently re-fire on H2 — a POST
        // could duplicate). If not, tag h3transport so json() falls back.
        failTransport: () => {
          if (pending.gotResponse) { bad(new Error('h3 stream error')) }
          else { const err: any = new Error('h3 transport: stream error'); err.h3transport = true; bad(err) }
        },
      }

      const headers = [
        { name: ':method', value: method },
        { name: ':path', value: path },
        { name: ':authority', value: this.h3host },
        { name: ':scheme', value: 'https' },
        { name: 'authorization', value: `Bearer ${this.apiKey}` },
      ]
      if (data) headers.push({ name: 'content-type', value: 'application/json' })
      try {
        sid = conn.client.sendRequest(headers, !data)
        conn.waiters.set(sid, pending)
        if (data) conn.client.streamSend(sid, Buffer.from(data), true)
      } catch (e: any) {
        const err: any = new Error('h3 transport: ' + e?.message); err.h3transport = true; return bad(err)
      }
      })
    } finally {
      this.releaseLoop()
    }
  }

  /** Create a new sandbox. */
  async create(options: CreateOptions = {}, opts: RequestOptions = {}): Promise<Sandbox> {
    const body: Record<string, any> = {
      image: options.image ?? 'node:22-slim',
      vcpus: options.vcpus,
      mem_mib: options.memMiB,
      disk_mib: options.diskMiB,
      timeout: options.timeoutSec ?? 300,
    }
    if (options.network) body.network = options.network
    if (options.networkProfile) body.network_profile = options.networkProfile
    if (options.credentials) body.credentials = options.credentials
    const res = await this.json<RunWire>('POST', '/v1/runs', body, opts)
    return new Sandbox(this, res.id, res)
  }

  /** Get a sandbox by ID. Returns null if not found. */
  async get(id: string): Promise<Sandbox | null> {
    try {
      const res = await this.json<RunWire>('GET', `/v1/runs/${id}`)
      return new Sandbox(this, id, res)
    } catch (e: any) {
      if (e instanceof IsorunError && e.status === 404) return null
      throw e
    }
  }

  /** List all active sandboxes. */
  async list(): Promise<Sandbox[]> {
    const res = await this.json<ListRunsWire | RunWire[]>('GET', '/v1/runs')
    const runs = Array.isArray(res) ? res : (res.runs ?? [])
    return runs.map((r) => new Sandbox(this, r.id, r))
  }

  /** Restore a sandbox from a snapshot. */
  async restore(snapshotId: string): Promise<Sandbox> {
    const res = await this.json<RunWire>('POST', '/v1/runs/restore', { snapshot_id: snapshotId })
    return new Sandbox(this, res.id, res)
  }

  /** List all snapshots. */
  async listSnapshots(): Promise<Snapshot[]> {
    const res = await this.json<ListSnapshotsWire>('GET', '/v1/snapshots')
    return (res.snapshots ?? []).map((s) => ({
      id: s.id, runId: s.run_id, sizeBytes: s.size_bytes ?? 0, createdAt: s.created_at ?? '',
    }))
  }

  /** Delete a snapshot by ID. Throws if the snapshot doesn't exist. */
  async deleteSnapshot(id: string): Promise<void> {
    await this.json<unknown>('DELETE', `/v1/snapshots/${encodeURIComponent(id)}`)
  }

  /** List the named egress profiles available on this runner. */
  async networkProfiles(): Promise<NetworkProfile[]> {
    return this.json<NetworkProfile[]>('GET', '/v1/network-profiles')
  }

  /** Live usage and cost summary for this account. */
  async usage(): Promise<UsageSummary> {
    const r = await this.json<UsageWire>('GET', '/v1/usage')
    return {
      activeSandboxes: r.active_sandboxes,
      historySandboxes: r.history_sandboxes,
      activeCostCents: r.active_cost_cents,
      historyCostCents: r.history_cost_cents,
      totalCostCents: r.total_cost_cents,
      cpuSeconds: r.cpu_seconds,
      memSeconds: r.mem_seconds,
      asOf: r.as_of,
    }
  }

  /** Past sandbox runs (destroyed sandboxes), newest first. */
  async history(): Promise<SandboxHistoryEntry[]> {
    const res = await this.json<HistoryWire>('GET', '/v1/runs/history')
    return (res.sandboxes ?? []).map((r) => ({
      id: r.id,
      image: r.image ?? '',
      vcpus: r.vcpus ?? 0,
      memMiB: r.mem_mib ?? 0,
      createMs: r.create_ms ?? 0,
      createdAt: r.created_at ?? '',
      destroyedAt: r.destroyed_at ?? '',
      uptimeMs: r.uptime_ms ?? 0,
      cpuMs: r.cpu_ms ?? 0,
      memPeakBytes: r.mem_peak_bytes ?? 0,
      costCents: r.cost_cents ?? 0,
    }))
  }

  // -- Internal HTTP helpers ------------------------------------------------

  /** @internal JSON request. */
  async json<T>(method: string, path: string, body?: Record<string, any>, opts: RequestOptions = {}): Promise<T> {
    const data = body ? JSON.stringify(body) : undefined
    // The in-flight semaphore wraps both transport paths.
    const rel = await this.sem.acquire()
    try {
      if (this.h3Enabled && !this.h3Broken) {
        // Open the full pool on first use, deferred a microtask so it can't race
        // the request's own lazy connect.
        if (!this.h3WarmKicked) {
          this.h3WarmKicked = true
          queueMicrotask(() => { void this.warmPool() })
        }
        try {
          return await this.h3Request<T>(method, path, data, opts)
        } catch (e: any) {
          // Only a transport failure (no response) falls through to HTTP/2; an
          // HTTP error or timeout means the server already acted, so propagate it
          // (retrying could duplicate a POST).
          if (!e?.h3transport) throw e
          // A connect-level failure trips the breaker so the rest of this client
          // skips the native transport. A mid-stream glitch on a healthy pool
          // just falls back this one request.
          if (e.h3connect) this.h3Broken = true
        }
      }
      const { statusCode, body: res } = await request(this.apiUrl + path, {
        dispatcher: this.dispatcher,
        method: method as any,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
        },
        body: data,
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
        signal: opts.signal,
      })
      const text = await res.text()
      if (statusCode >= 200 && statusCode < 300) return text ? JSON.parse(text) : ({} as T)
      throw new IsorunError(statusCode, `HTTP ${statusCode}: ${text.slice(0, 200)}`, text)
    } finally {
      rel()
    }
  }

  /** @internal Raw binary request for file operations. */
  async raw(method: string, path: string, body?: Buffer, opts: RequestOptions = {}): Promise<Buffer> {
    const { statusCode, body: res } = await request(this.apiUrl + path, {
      dispatcher: this.dispatcher,
      method: method as any,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body,
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
      signal: opts.signal,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (statusCode >= 200 && statusCode < 300) return buf
    const text = buf.toString('utf8')
    throw new IsorunError(statusCode, `HTTP ${statusCode}: ${text.slice(0, 200)}`, text)
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/** A running Isorun sandbox. Execute commands, read/write files, destroy. */
export class Sandbox {
  readonly id: string
  readonly createMs: number
  readonly image: string
  readonly vcpus: number
  readonly memMiB: number
  readonly diskMiB: number

  /** @internal */ readonly client: Isorun

  /** @internal */
  constructor(client: Isorun, id: string, record: Partial<RunWire>) {
    this.client = client
    this.id = id
    this.createMs = record.create_ms ?? 0
    this.image = record.image ?? ''
    this.vcpus = record.vcpus ?? 0
    this.memMiB = record.mem_mib ?? 0
    this.diskMiB = record.disk_mib ?? 0
  }

  /** Execute a command and return the result. */
  async exec(command: string, timeoutSec = 30, opts: RequestOptions = {}): Promise<ExecResult> {
    const res = await this.client.json<ExecWire>('POST', `/v1/runs/${this.id}/exec`, {
      command,
      timeout: timeoutSec,
    }, opts)
    return { exitCode: res.exit_code ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  /** Write a file to the sandbox. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const buf = typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    await this.client.raw('POST', `/v1/runs/${this.id}/files/upload?path=${encodeURIComponent(path)}`, buf)
  }

  /** Read a file from the sandbox, returning the contents as UTF-8. */
  async readFile(path: string): Promise<string> {
    const buf = await this.client.raw('GET', `/v1/runs/${this.id}/files/download?path=${encodeURIComponent(path)}`)
    return buf.toString('utf8')
  }

  /** List directory contents. */
  async readdir(path: string): Promise<FileEntry[]> {
    const res = await this.client.json<ReaddirWire>('GET', `/v1/runs/${this.id}/files?path=${encodeURIComponent(path)}`)
    return (res.entries ?? []).map((name) => ({ name }))
  }

  /** Get sandbox metadata. */
  async info(): Promise<SandboxInfo> {
    const r = await this.client.json<RunWire>('GET', `/v1/runs/${this.id}`)
    return {
      id: r.id, status: r.status ?? '', image: r.image ?? '',
      vcpus: r.vcpus ?? 0, memMiB: r.mem_mib ?? 0, diskMiB: r.disk_mib ?? 0,
      createMs: r.create_ms ?? 0, createdAt: r.created_at ?? '',
    }
  }

  /** Snapshot the sandbox. The returned `id` can be passed to `isorun.restore(id)`. */
  async snapshot(): Promise<Snapshot> {
    const r = await this.client.json<SnapshotWire>('POST', `/v1/runs/${this.id}/snapshot`)
    return { id: r.snapshot_id, runId: r.run_id, sizeBytes: r.size_bytes ?? 0, createdAt: r.created_at ?? '' }
  }

  /** Fork the sandbox into N independent clones, each running immediately. */
  async fork(count = 1): Promise<Sandbox[]> {
    const r = await this.client.json<ForkWire>('POST', `/v1/runs/${this.id}/fork`, { count })
    return (r.forks ?? []).map((f) => new Sandbox(this.client, f.id, f))
  }

  /** Hibernate the sandbox - pause and snapshot to disk. Costs nothing while hibernated. Resume with `resume()`. */
  async hibernate(): Promise<void> {
    await this.client.json<unknown>('POST', `/v1/runs/${this.id}/hibernate`)
  }

  /** Resume a hibernated sandbox and transition it back to running. */
  async resume(): Promise<void> {
    await this.client.json<unknown>('POST', `/v1/runs/${this.id}/resume`)
  }

  /** Reset the auto-destroy timeout. Use as a keep-alive. Pass 0 to disable. */
  async setTimeout(seconds: number): Promise<void> {
    await this.client.json<unknown>('PATCH', `/v1/runs/${this.id}`, { timeout: seconds })
  }

  /** Fetch the audit trail for this sandbox. Useful for compliance and debugging. */
  async auditLog(): Promise<AuditEntry[]> {
    const buf = await this.client.raw('GET', `/v1/runs/${this.id}/audit`)
    return buf
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const e = JSON.parse(line) as AuditWire
        return {
          seq: e.seq,
          timestamp: e.ts,
          sandboxId: e.sandbox_id,
          event: e.event,
          data: e.data ?? {},
          hmac: e.hmac,
        }
      })
  }

  /**
   * Build the proxy URL for a port the guest service is listening on.
   *
   * Returns `{runner}/v1/runs/{id}/proxy/{port}{path}`, which requires
   * `Authorization: Bearer ${apiKey}` on the request.
   *
   * @param port port the guest service is listening on (1-65535)
   * @param path optional path segment, defaults to `/`
   */
  url(port: number, path: string = '/'): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`port must be an integer in [1, 65535], got ${port}`)
    }
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${this.client.apiUrl}/v1/runs/${this.id}/proxy/${port}${suffix}`
  }

  /** Destroy the sandbox and release resources. */
  async destroy(): Promise<DestroyResult> {
    const r = await this.client.json<DestroyWire>('DELETE', `/v1/runs/${this.id}`)
    return {
      status: r.status ?? '',
      cpuMs: r.cpu_ms ?? 0,
      memPeakBytes: r.mem_peak_bytes ?? 0,
      uptimeMs: r.uptime_ms ?? 0,
      costCents: r.cost_cents ?? 0,
    }
  }
}
