/**
 * Offline unit test for the orchestrator session→sandbox binding.
 *
 * Mocks the Anthropic client + Isorun SDK to verify:
 *   - Empty metadata → allocate fresh, keep alive (no destroy)
 *   - `isorun.image` from session.metadata overrides the operator default
 *   - `isorun.sandbox_id` (customer BYO) → attach, NEVER destroy
 *   - Two work items for the same sessionId in one orchestrator run reuse
 *     the same sandbox (no second allocation)
 *   - Scoped env key never appears in the exec command line
 *   - `setTimeout` is called on sandboxes we own (idle TTL refresh)
 */

import { describe, expect, it, vi } from 'vitest'
import { runOrchestrator } from '../claude-agents/orchestrator.js'

interface FakeSandbox {
  id: string
  destroyed: boolean
  writes: Array<{ path: string; content: string }>
  execs: string[]
  setTimeoutCalls: number[]
  writeFile: (path: string, content: string) => Promise<void>
  exec: (cmd: string, _timeout: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  destroy: () => Promise<void>
  setTimeout: (seconds: number) => Promise<void>
}

function makeSandbox(id: string): FakeSandbox {
  const sb: FakeSandbox = {
    id,
    destroyed: false,
    writes: [],
    execs: [],
    setTimeoutCalls: [],
    writeFile: async (path, content) => { sb.writes.push({ path, content }) },
    exec: async (cmd) => { sb.execs.push(cmd); return { exitCode: 0, stdout: '', stderr: '' } },
    destroy: async () => { sb.destroyed = true },
    setTimeout: async (seconds) => { sb.setTimeoutCalls.push(seconds) },
  }
  return sb
}

interface RunArgs {
  metadata: Record<string, string>
  /** Sandboxes the test pre-creates and stages into isorun.get(id) responses. */
  preExisting?: FakeSandbox[]
  operatorImage?: string
  /** Work items to deliver to the orchestrator's poller (defaults to 1). */
  workItems?: Array<{ id: string; sessionId: string }>
}

async function runOnce(args: RunArgs) {
  const created: FakeSandbox[] = []
  const isorun = {
    create: vi.fn(async () => {
      const sb = makeSandbox(`vm-${created.length}`)
      created.push(sb)
      return sb
    }),
    get: vi.fn(async (id: string) => {
      const fromCreated = created.find((s) => s.id === id)
      if (fromCreated) return fromCreated
      const fromPre = args.preExisting?.find((s) => s.id === id)
      return fromPre ?? null
    }),
  }

  const workItems = (args.workItems ?? [{ id: 'work-1', sessionId: 'sess-1' }]).map((w) => ({
    id: w.id,
    data: { id: w.sessionId },
  }))

  const fakeClient = {
    beta: {
      sessions: {
        retrieve: vi.fn(async (sid: string) => ({ id: sid, metadata: args.metadata })),
      },
      environments: { work: { stop: vi.fn(async () => {}) } },
    },
  }

  vi.doMock('@anthropic-ai/sdk', () => ({
    default: class FakeAnthropic {
      constructor() { return fakeClient }
    },
  }))
  vi.doMock('@anthropic-ai/sdk/helpers/beta/environments', () => ({
    WorkPoller: class {
      constructor() { /* noop */ }
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next() {
            if (i >= workItems.length) return { done: true as const, value: undefined }
            return { done: false as const, value: workItems[i++] }
          },
        }
      }
    },
  }))

  await runOrchestrator({
    isorun: isorun as any,
    environmentId: 'env_test',
    environmentKey: 'sk-ant-oat01-SECRET',
    image: args.operatorImage ?? 'docker.io/isorun/claude-agents:0.4.3',
    vcpus: 2,
    memMiB: 4096,
  })

  return { created, isorun, preExisting: args.preExisting }
}

describe('orchestrator session→sandbox binding', () => {
  it('allocates fresh on first turn and keeps the sandbox alive', async () => {
    const { created, isorun } = await runOnce({ metadata: {} })
    expect(isorun.create).toHaveBeenCalledTimes(1)
    expect(created[0]!.destroyed).toBe(false)
    expect(created[0]!.setTimeoutCalls).toContain(30 * 60) // server-side TTL refresh
  })

  it('honours isorun.image override at allocation', async () => {
    const { isorun } = await runOnce({
      metadata: { 'isorun.image': 'custom-registry/my-agents:v2' },
    })
    expect(isorun.create.mock.calls[0]![0].image).toBe('custom-registry/my-agents:v2')
  })

  it('attaches to customer BYO sandbox_id and never destroys/refreshes it', async () => {
    const preExisting = makeSandbox('pre-warmed-123')
    const { isorun } = await runOnce({
      metadata: { 'isorun.sandbox_id': 'pre-warmed-123' },
      preExisting: [preExisting],
    })
    expect(isorun.create).not.toHaveBeenCalled()
    expect(isorun.get).toHaveBeenCalledWith('pre-warmed-123')
    expect(preExisting.destroyed).toBe(false)
    expect(preExisting.execs).toHaveLength(1)
    // setTimeout is not called on customer-owned sandboxes - they manage TTL.
    expect(preExisting.setTimeoutCalls).toHaveLength(0)
  })

  it('reuses the same sandbox for two work items on the same session (multi-turn)', async () => {
    const { created, isorun } = await runOnce({
      metadata: {},
      workItems: [
        { id: 'work-A', sessionId: 'sess-multi' },
        { id: 'work-B', sessionId: 'sess-multi' },
      ],
    })
    expect(isorun.create).toHaveBeenCalledTimes(1) // one allocation across both work items
    expect(created).toHaveLength(1)
    expect(created[0]!.execs).toHaveLength(2)      // runner re-exec'd for each
    expect(created[0]!.writes).toHaveLength(2)     // work context uploaded each time
    expect(created[0]!.destroyed).toBe(false)
    // Each work item refreshes the server-side TTL.
    expect(created[0]!.setTimeoutCalls).toHaveLength(2)
  })

  it('allocates separate sandboxes for two different sessions', async () => {
    const { created, isorun } = await runOnce({
      metadata: {},
      workItems: [
        { id: 'work-A', sessionId: 'sess-A' },
        { id: 'work-B', sessionId: 'sess-B' },
      ],
    })
    expect(isorun.create).toHaveBeenCalledTimes(2)
    expect(created).toHaveLength(2)
    expect(created[0]!.id).not.toBe(created[1]!.id)
  })

  it('never embeds the scoped env key in the exec command line', async () => {
    const { created } = await runOnce({ metadata: {} })
    for (const cmd of created[0]!.execs) {
      expect(cmd).not.toContain('sk-ant-oat01-SECRET')
      expect(cmd).not.toContain('ANTHROPIC_ENVIRONMENT_KEY=')
    }
    const ctx = JSON.parse(created[0]!.writes[0]!.content)
    expect(ctx.environmentKey).toBe('sk-ant-oat01-SECRET')
    expect(ctx.sessionId).toBe('sess-1')
  })
})
