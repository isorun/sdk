import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Isorun, Sandbox, IsorunError } from '../index.js'
import { createMockServer } from './mock-server.js'

// These tests run against a plain HTTP mock, so exercise the HTTP/2 path
// deterministically: the breaker is forced in beforeAll so the client skips
// the native transport (which has no server here).

const mock = createMockServer()
let port: number
let client: Isorun

beforeAll(async () => {
  port = await mock.start()
  client = new Isorun({ apiKey: 'test_key', apiUrl: `http://127.0.0.1:${port}` })
  // Force the HTTP/2 fallback path: there's no native-transport server behind
  // the mock, and an attempted connect would hang until the connect timeout.
  ;(client as unknown as { h3Broken: boolean }).h3Broken = true
})

afterAll(() => {
  client.close()
  return mock.stop()
})
beforeEach(() => mock.reset())

// ---------------------------------------------------------------------------
// Isorun client
// ---------------------------------------------------------------------------

describe('Isorun', () => {
  it('throws if no API key is provided', () => {
    const orig = process.env.ISORUN_API_KEY
    delete process.env.ISORUN_API_KEY
    expect(() => new Isorun({ apiUrl: 'http://localhost' })).toThrow('Missing API key')
    if (orig) process.env.ISORUN_API_KEY = orig
  })

  it('reads API key from env var', () => {
    const orig = process.env.ISORUN_API_KEY
    process.env.ISORUN_API_KEY = 'env_key'
    const c = new Isorun({ apiUrl: 'http://localhost' })
    expect(c).toBeDefined()
    if (orig) process.env.ISORUN_API_KEY = orig
    else delete process.env.ISORUN_API_KEY
  })

  it('strips trailing slash from apiUrl', () => {
    const c = new Isorun({ apiKey: 'k', apiUrl: 'http://localhost:1234/' })
    expect((c as any).apiUrl).toBe('http://localhost:1234')
  })

  it('prepends https:// when no protocol given', () => {
    const c = new Isorun({ apiKey: 'k', apiUrl: 'example.com' })
    expect((c as any).apiUrl).toBe('https://example.com')
  })
})

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('create', () => {
  it('sends POST /v1/runs and returns a Sandbox', async () => {
    mock.route('POST', '/v1/runs', 200, {
      id: 'run_abc',
      image: 'node:22-slim',
      create_ms: 11,
      status: 'running',
    })

    const sb = await client.create({ image: 'node:22-slim', vcpus: 2, memMiB: 512 })
    expect(sb.id).toBe('run_abc')
    expect(sb.createMs).toBe(11)
    expect(sb.image).toBe('node:22-slim')

    const req = mock.lastRequest()
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/runs')
    expect(req.headers.authorization).toBe('Bearer test_key')

    const body = JSON.parse(req.body)
    expect(body.image).toBe('node:22-slim')
    expect(body.vcpus).toBe(2)
    expect(body.mem_mib).toBe(512)
  })

  it('uses default image when none specified', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_def', image: 'node:22-slim', create_ms: 5 })
    await client.create()

    const body = JSON.parse(mock.lastRequest().body)
    expect(body.image).toBe('node:22-slim')
    expect(body.timeout).toBe(300)
    expect(body).not.toHaveProperty('timeout_sec')
  })

  it('throws on server error', async () => {
    mock.route('POST', '/v1/runs', 503, { error: 'overloaded' })
    await expect(client.create()).rejects.toThrow('HTTP 503')
  })
})

// ---------------------------------------------------------------------------
// IsorunError
// ---------------------------------------------------------------------------

describe('IsorunError', () => {
  it('throws a typed IsorunError carrying the status code and body', async () => {
    mock.route('POST', '/v1/runs', 500, { error: 'boom' })
    const e = await client.create().catch((err) => err)
    expect(e).toBeInstanceOf(IsorunError)
    expect(e).toBeInstanceOf(Error)
    expect(e.status).toBe(500)
    expect(e.body).toContain('boom')
  })

  it('lets callers branch on status (e.g. 429) instead of string-matching', async () => {
    mock.route('POST', '/v1/runs/run_1/exec', 429, { error: 'capacity' })
    const sb = new Sandbox(client, 'run_1', {})
    const e = await sb.exec('true').catch((err) => err)
    expect(e).toBeInstanceOf(IsorunError)
    expect(e.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('rejects a request whose signal is already aborted', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_x' })
    const ac = new AbortController()
    ac.abort()
    await expect(client.create({}, { signal: ac.signal })).rejects.toThrow()
  })

  it('rejects an exec aborted mid-flight', async () => {
    mock.route('POST', '/v1/runs/run_2/exec', 200, { exit_code: 0, stdout: '', stderr: '' })
    const sb = new Sandbox(client, 'run_2', {})
    const ac = new AbortController()
    const p = sb.exec('sleep 5', 30, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('get', () => {
  it('returns a Sandbox when found', async () => {
    mock.route('GET', '/v1/runs/run_123', 200, {
      id: 'run_123', image: 'python:3.12-slim', status: 'running', create_ms: 8,
    })

    const sb = await client.get('run_123')
    expect(sb).not.toBeNull()
    expect(sb!.id).toBe('run_123')
    expect(sb!.image).toBe('python:3.12-slim')
  })

  it('returns null on 404', async () => {
    mock.route('GET', '/v1/runs/run_gone', 404, { error: 'not found' })
    const sb = await client.get('run_gone')
    expect(sb).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns array of Sandbox objects', async () => {
    mock.route('GET', '/v1/runs', 200, {
      runs: [
        { id: 'run_1', image: 'alpine', create_ms: 3 },
        { id: 'run_2', image: 'ubuntu', create_ms: 7 },
      ],
    })

    const sandboxes = await client.list()
    expect(sandboxes).toHaveLength(2)
    expect(sandboxes[0].id).toBe('run_1')
    expect(sandboxes[1].id).toBe('run_2')
  })

  it('handles flat array response', async () => {
    mock.route('GET', '/v1/runs', 200, [
      { id: 'run_a', image: 'node', create_ms: 1 },
    ])

    const sandboxes = await client.list()
    expect(sandboxes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('restore', () => {
  it('sends snapshot_id in body', async () => {
    mock.route('POST', '/v1/runs/restore', 200, { id: 'run_restored', image: 'node', create_ms: 23 })

    const sb = await client.restore('snap_xyz')
    expect(sb.id).toBe('run_restored')

    const body = JSON.parse(mock.lastRequest().body)
    expect(body.snapshot_id).toBe('snap_xyz')
  })
})

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

describe('listSnapshots', () => {
  it('maps snake_case response to camelCase', async () => {
    mock.route('GET', '/v1/snapshots', 200, {
      snapshots: [
        { id: 'snap_1', run_id: 'run_1', size_bytes: 1024, created_at: '2026-04-18T00:00:00Z' },
      ],
    })

    const snaps = await client.listSnapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].id).toBe('snap_1')
    expect(snaps[0].runId).toBe('run_1')
    expect(snaps[0].sizeBytes).toBe(1024)
    expect(snaps[0].createdAt).toBe('2026-04-18T00:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// Sandbox - exec
// ---------------------------------------------------------------------------

describe('Sandbox.exec', () => {
  it('sends command and parses result', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_e', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_e/exec', 200, {
      exit_code: 0, stdout: 'hello\n', stderr: '',
    })

    const sb = await client.create()
    const res = await sb.exec('echo hello')

    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('hello\n')
    expect(res.stderr).toBe('')

    const req = mock.requests.find(r => r.url === '/v1/runs/run_e/exec')!
    const body = JSON.parse(req.body)
    expect(body.command).toBe('echo hello')
    expect(body.timeout).toBe(30)
  })

  it('respects custom timeout', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_t', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_t/exec', 200, { exit_code: 0, stdout: '', stderr: '' })

    const sb = await client.create()
    await sb.exec('sleep 60', 120)

    const req = mock.requests.find(r => r.url === '/v1/runs/run_t/exec')!
    expect(JSON.parse(req.body).timeout).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// Sandbox - file operations
// ---------------------------------------------------------------------------

describe('Sandbox file operations', () => {
  let sbId: string

  beforeEach(async () => {
    sbId = 'run_f'
    mock.route('POST', '/v1/runs', 200, { id: sbId, image: 'node', create_ms: 5 })
  })

  it('writeFile sends binary POST', async () => {
    mock.route('POST', `/v1/runs/${sbId}/files/upload`, 200, {}, 'application/octet-stream')
    const sb = await client.create()
    await sb.writeFile('/tmp/test.txt', 'file contents')

    const req = mock.requests.find(r => r.url?.startsWith(`/v1/runs/${sbId}/files/upload`))!
    expect(req.method).toBe('POST')
    expect(req.url).toContain('path=%2Ftmp%2Ftest.txt')
    expect(req.headers['content-type']).toBe('application/octet-stream')
  })

  it('readFile returns string content', async () => {
    mock.route('GET', `/v1/runs/${sbId}/files/download`, 200, Buffer.from('read content'), 'application/octet-stream')
    const sb = await client.create()
    const content = await sb.readFile('/tmp/test.txt')
    expect(content).toBe('read content')
  })

  it('readdir returns FileEntry array', async () => {
    mock.route('GET', `/v1/runs/${sbId}/files`, 200, { entries: ['file1.txt', 'dir1'] })
    const sb = await client.create()
    const entries = await sb.readdir('/tmp')

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: 'file1.txt' })
    expect(entries[1]).toEqual({ name: 'dir1' })
  })
})

// ---------------------------------------------------------------------------
// Sandbox - info
// ---------------------------------------------------------------------------

describe('Sandbox.info', () => {
  it('maps snake_case response fields', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_i', image: 'node', create_ms: 5 })
    mock.route('GET', '/v1/runs/run_i', 200, {
      id: 'run_i', status: 'running', image: 'node:22-slim',
      vcpus: 2, mem_mib: 1024, disk_mib: 4096,
      create_ms: 11, created_at: '2026-04-18T12:00:00Z',
    })

    const sb = await client.create()
    const info = await sb.info()

    expect(info.id).toBe('run_i')
    expect(info.status).toBe('running')
    expect(info.memMiB).toBe(1024)
    expect(info.diskMiB).toBe(4096)
    expect(info.createMs).toBe(11)
    expect(info.createdAt).toBe('2026-04-18T12:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// Sandbox - snapshot
// ---------------------------------------------------------------------------

describe('Sandbox.snapshot', () => {
  it('returns SnapshotInfo with camelCase fields', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_s', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_s/snapshot', 200, {
      snapshot_id: 'snap_abc', run_id: 'run_s', size_bytes: 2048, created_at: '2026-04-18T13:00:00Z',
    })

    const sb = await client.create()
    const snap = await sb.snapshot()

    expect(snap.id).toBe('snap_abc')
    expect(snap.runId).toBe('run_s')
    expect(snap.sizeBytes).toBe(2048)
  })
})

// ---------------------------------------------------------------------------
// Sandbox - fork
// ---------------------------------------------------------------------------

describe('Sandbox.fork', () => {
  it('returns array of forked Sandbox objects', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_fk', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_fk/fork', 200, {
      forks: [
        { id: 'run_fk_1', image: 'node', create_ms: 2 },
        { id: 'run_fk_2', image: 'node', create_ms: 3 },
      ],
    })

    const sb = await client.create()
    const forks = await sb.fork(2)

    expect(forks).toHaveLength(2)
    expect(forks[0].id).toBe('run_fk_1')
    expect(forks[1].id).toBe('run_fk_2')

    const body = JSON.parse(mock.requests.find(r => r.url?.includes('/fork'))!.body)
    expect(body.count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Sandbox - hibernate / resume
// ---------------------------------------------------------------------------

describe('Sandbox.hibernate and resume', () => {
  it('sends POST to hibernate endpoint', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_h', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_h/hibernate', 200, {})

    const sb = await client.create()
    await sb.hibernate()

    const req = mock.requests.find(r => r.url === '/v1/runs/run_h/hibernate')!
    expect(req.method).toBe('POST')
  })

  it('sends POST to resume endpoint', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_r', image: 'node', create_ms: 5 })
    mock.route('POST', '/v1/runs/run_r/resume', 200, {})

    const sb = await client.create()
    await sb.resume()

    const req = mock.requests.find(r => r.url === '/v1/runs/run_r/resume')!
    expect(req.method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// Sandbox - setTimeout
// ---------------------------------------------------------------------------

describe('Sandbox.setTimeout', () => {
  it('sends PATCH with timeout value', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_to', image: 'node', create_ms: 5 })
    mock.route('PATCH', '/v1/runs/run_to', 200, {})

    const sb = await client.create()
    await sb.setTimeout(600)

    const req = mock.requests.find(r => r.method === 'PATCH')!
    expect(JSON.parse(req.body).timeout).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// Sandbox - destroy
// ---------------------------------------------------------------------------

describe('Sandbox.destroy', () => {
  it('returns DestroyResult with mapped fields', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_d', image: 'node', create_ms: 5 })
    mock.route('DELETE', '/v1/runs/run_d', 200, {
      status: 'destroyed', cpu_ms: 150, mem_peak_bytes: 52428800, uptime_ms: 30000, cost_cents: 0.04,
    })

    const sb = await client.create()
    const result = await sb.destroy()

    expect(result.status).toBe('destroyed')
    expect(result.cpuMs).toBe(150)
    expect(result.memPeakBytes).toBe(52428800)
    expect(result.uptimeMs).toBe(30000)
    expect(result.costCents).toBe(0.04)
  })
})

// ---------------------------------------------------------------------------
// deleteSnapshot
// ---------------------------------------------------------------------------

describe('deleteSnapshot', () => {
  it('sends DELETE /v1/snapshots/{id}', async () => {
    mock.route('DELETE', '/v1/snapshots/snap_x', 200, {})
    await client.deleteSnapshot('snap_x')

    const req = mock.lastRequest()
    expect(req.method).toBe('DELETE')
    expect(req.url).toBe('/v1/snapshots/snap_x')
  })
})

// ---------------------------------------------------------------------------
// networkProfiles / usage / history
// ---------------------------------------------------------------------------

describe('networkProfiles', () => {
  it('returns the profile array (server responds with a bare array)', async () => {
    mock.route('GET', '/v1/network-profiles', 200, [
      { name: 'web-dev', description: 'npm + CDNs', allow: ['registry.npmjs.org'], deny: ['0.0.0.0/0'] },
    ])

    const profiles = await client.networkProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0].name).toBe('web-dev')
    expect(profiles[0].allow).toContain('registry.npmjs.org')
  })
})

describe('usage', () => {
  it('maps the snake_case usage summary', async () => {
    mock.route('GET', '/v1/usage', 200, {
      active_sandboxes: 2, history_sandboxes: 36,
      active_cost_cents: 0.5, history_cost_cents: 1.2, total_cost_cents: 1.7,
      cpu_seconds: 31.4, mem_seconds: 31.4, as_of: '2026-05-27T00:00:00Z',
    })

    const u = await client.usage()
    expect(u.activeSandboxes).toBe(2)
    expect(u.historySandboxes).toBe(36)
    expect(u.totalCostCents).toBe(1.7)
    expect(u.asOf).toBe('2026-05-27T00:00:00Z')
  })
})

describe('history', () => {
  it('maps destroyed-sandbox records and drops server-internal fields', async () => {
    mock.route('GET', '/v1/runs/history', 200, {
      sandboxes: [
        {
          id: 'run_h1', image: 'node-22-slim', vcpus: 1, mem_mib: 1024, region: 'us',
          create_ms: 1, created_at: '2026-05-27T00:00:00Z', destroyed_at: '2026-05-27T00:01:00Z',
          uptime_ms: 60000, cost_cents: 0.01, cpu_ms: 120, mem_peak_bytes: 10485760,
        },
      ],
    })

    const h = await client.history()
    expect(h).toHaveLength(1)
    expect(h[0].id).toBe('run_h1')
    expect(h[0].memMiB).toBe(1024)
    expect(h[0].memPeakBytes).toBe(10485760)
    expect(h[0].destroyedAt).toBe('2026-05-27T00:01:00Z')
    expect(h[0]).not.toHaveProperty('region')
  })
})

// ---------------------------------------------------------------------------
// Sandbox - url (proxy URL builder, no network)
// ---------------------------------------------------------------------------

describe('Sandbox.url', () => {
  it('builds a path-based proxy URL on the runner', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_u', image: 'node', create_ms: 1 })
    const sb = await client.create()

    expect(sb.url(3000)).toBe(`${(client as any).apiUrl}/v1/runs/run_u/proxy/3000/`)
    expect(sb.url(8080, '/health')).toBe(`${(client as any).apiUrl}/v1/runs/run_u/proxy/8080/health`)
  })

  it('builds the same path form for a remote runner', () => {
    const remote = new Isorun({ apiKey: 'isorun_live_us_a_b', apiUrl: 'https://run-us.isorun.ai' })
    const id = 'runa1b2c3d4e5f6a7b8c9d0'
    const sb = new Sandbox(remote, id, {})
    expect(sb.url(3000)).toBe(`https://run-us.isorun.ai/v1/runs/${id}/proxy/3000/`)
    remote.close()
  })

  it('rejects out-of-range ports', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_p', image: 'node', create_ms: 1 })
    const sb = await client.create()
    expect(() => sb.url(0)).toThrow(RangeError)
    expect(() => sb.url(70000)).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// Sandbox - auditLog (JSONL)
// ---------------------------------------------------------------------------

describe('Sandbox.auditLog', () => {
  it('parses JSONL audit entries into typed records', async () => {
    mock.route('POST', '/v1/runs', 200, { id: 'run_a', image: 'node', create_ms: 1 })
    const jsonl = [
      JSON.stringify({ seq: 0, ts: '2026-05-27T00:00:00Z', sandbox_id: 'run_a', event: 'sandbox.created', data: {}, hmac: 'sha256:aaa' }),
      JSON.stringify({ seq: 1, ts: '2026-05-27T00:00:01Z', sandbox_id: 'run_a', event: 'exec.start', data: { cmd: 'node -v' }, hmac: 'sha256:bbb' }),
    ].join('\n') + '\n'
    mock.route('GET', '/v1/runs/run_a/audit', 200, jsonl, 'application/octet-stream')

    const sb = await client.create()
    const entries = await sb.auditLog()

    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(0)
    expect(entries[0].event).toBe('sandbox.created')
    expect(entries[1].timestamp).toBe('2026-05-27T00:00:01Z')
    expect(entries[1].sandboxId).toBe('run_a')
    expect(entries[1].data).toEqual({ cmd: 'node -v' })
  })
})
