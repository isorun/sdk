/**
 * Claude Managed Agents orchestrator - host side.
 *
 * Polls Anthropic's environment work queue. For each claimed work item, looks
 * up the session's bound sandbox (or allocates one), invokes the in-VM runner
 * for that work item, and keeps the sandbox bound for subsequent work items in
 * the same session.
 *
 * Session→sandbox affinity:
 *   - Customer BYO override: `session.metadata['isorun.sandbox_id']` - never
 *     allocated or destroyed by the orchestrator.
 *   - Otherwise: an in-process map keyed by sessionId holds the allocated
 *     sandbox, reused for subsequent work items in the same session so
 *     filesystem state persists across user turns. A server-side idle TTL,
 *     refreshed on each work item, cleans it up once no further work arrives.
 *
 * Reference: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
 */

import type { Isorun, Sandbox } from '../index.js'

export interface OrchestratorOptions {
  /** Isorun SDK client (already authenticated). */
  isorun: Isorun
  /** Anthropic environment ID (env_…). */
  environmentId: string
  /** Anthropic environment key (sk-ant-oat01-…). NOT the org API key. */
  environmentKey: string
  /** Isorun base image. Must contain bash + unzip + tar + Node.js 22+. */
  image: string
  /** vCPUs per session VM. */
  vcpus: number
  /** Memory in MiB per session VM. */
  memMiB: number
  /** Anthropic API base (override for testing). */
  anthropicBaseUrl?: string
  /** Abort signal - orchestrator drains in-flight sessions then exits. */
  signal?: AbortSignal
  /** Hook for tests/observability - called for each work item lifecycle event. */
  onEvent?: (event: OrchestratorEvent) => void
  /** Max per-session exec timeout (seconds). Default 3600 (1h). */
  sessionTimeoutSec?: number
  /** Sandbox server-side TTL refreshed on each work item (seconds). Default 1800 (30 min). */
  sandboxIdleTtlSec?: number
}

export type OrchestratorEvent =
  | { type: 'work_claimed'; workId: string; sessionId: string }
  | { type: 'vm_allocated'; workId: string; sandboxId: string; bootMs: number; reused: boolean }
  | { type: 'work_completed'; workId: string; durationMs: number }
  | { type: 'work_failed'; workId: string; error: string }

interface SessionBinding {
  sandbox: Sandbox
  weOwnIt: boolean
}

/**
 * Run the orchestrator until the abort signal fires.
 */
export async function runOrchestrator(opts: OrchestratorOptions): Promise<void> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpers: any = await import('@anthropic-ai/sdk/helpers/beta/environments')
  const { WorkPoller } = helpers

  const client = new Anthropic({
    // Suppress the env-key + org-key conflict on hosts where
    // ANTHROPIC_API_KEY is set (the SDK auto-includes it as x-api-key
    // alongside the Bearer env-key, and the server returns 401).
    apiKey: '',
    authToken: opts.environmentKey,
    ...(opts.anthropicBaseUrl ? { baseURL: opts.anthropicBaseUrl } : {}),
    defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
  })

  const poller = new WorkPoller({
    client,
    environmentId: opts.environmentId,
    environmentKey: opts.environmentKey,
    autoStop: false,
    signal: opts.signal,
  })

  // Session→sandbox map for this worker process. Survives across work
  // items; on shutdown we let the sandbox's server-side TTL reap them
  // rather than destroying each one.
  const bindings = new Map<string, SessionBinding>()
  // Per-session tail promises serialize handleWork calls for the same
  // session, so a second work item never races the first's allocation.
  // Anthropic emits work items sequentially per session in practice, but
  // the lock makes us robust to retries / fast re-claims after stop.
  const sessionTails = new Map<string, Promise<void>>()

  const inflight = new Set<Promise<void>>()

  for await (const work of poller as AsyncIterable<WorkItem>) {
    if (opts.signal?.aborted) break

    const sessionId = work.data.id
    const tail = sessionTails.get(sessionId) ?? Promise.resolve()
    const next = tail.then(() => handleWork(opts, work, client, bindings))
    const session = next.catch((err) => {
      opts.onEvent?.({
        type: 'work_failed',
        workId: work.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    // Keep a swallowed tail in the map so the next handleWork chains
    // after this one without inheriting a rejection.
    sessionTails.set(sessionId, session)
    inflight.add(session)
    session.finally(() => {
      inflight.delete(session)
      // Best-effort cleanup once the tail for this session is fully
      // drained (the map ref we stored IS the current tail).
      if (sessionTails.get(sessionId) === session) {
        sessionTails.delete(sessionId)
      }
    })
  }

  await Promise.allSettled([...inflight])
}

interface WorkItem {
  id: string
  data: { id: string }
}

const META_BYO = 'isorun.sandbox_id'

async function handleWork(
  opts: OrchestratorOptions,
  work: WorkItem,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  bindings: Map<string, SessionBinding>,
): Promise<void> {
  const startedAt = Date.now()
  const sessionId = work.data.id
  const sessionTimeoutSec = opts.sessionTimeoutSec ?? 60 * 60
  const sandboxIdleTtlSec = opts.sandboxIdleTtlSec ?? 30 * 60

  opts.onEvent?.({ type: 'work_claimed', workId: work.id, sessionId })

  // Fetch metadata for per-session overrides (image, BYO sandbox).
  let sessionMetadata: Record<string, string> = {}
  try {
    const sess = await client.beta.sessions.retrieve(sessionId)
    sessionMetadata = (sess?.metadata ?? {}) as Record<string, string>
  } catch {
    /* best-effort */
  }
  const overrideImage = sessionMetadata['isorun.image']
  const customerBYO = sessionMetadata[META_BYO]

  // Resolution order:
  //   1. In-process binding from a prior work item in this session
  //   2. Customer BYO sandbox (we never destroy)
  //   3. Allocate fresh
  let sandbox: Sandbox
  let weOwnIt: boolean
  let reused = false
  const bootStart = Date.now()
  try {
    const cached = bindings.get(sessionId)
    if (cached) {
      // Verify the cached sandbox is still alive - server-side TTL or
      // an admin destroy may have reaped it since the last turn.
      const fresh = await opts.isorun.get(cached.sandbox.id).catch(() => null)
      if (fresh) {
        sandbox = fresh
        weOwnIt = cached.weOwnIt
        reused = true
      } else {
        bindings.delete(sessionId)
        sandbox = await allocateSandbox(opts, overrideImage, sessionTimeoutSec)
        weOwnIt = true
        bindings.set(sessionId, { sandbox, weOwnIt })
      }
    } else if (customerBYO) {
      const existing = await opts.isorun.get(customerBYO)
      if (!existing) {
        throw new Error(`session.metadata['${META_BYO}']=${customerBYO} not found`)
      }
      sandbox = existing
      weOwnIt = false
      reused = true
      bindings.set(sessionId, { sandbox, weOwnIt })
    } else {
      sandbox = await allocateSandbox(opts, overrideImage, sessionTimeoutSec)
      weOwnIt = true
      bindings.set(sessionId, { sandbox, weOwnIt })
    }
  } catch (err) {
    try {
      await client.beta.environments.work.stop(work.id, {
        environment_id: opts.environmentId,
      })
    } catch {
      /* best-effort */
    }
    throw err
  }
  const bootMs = Date.now() - bootStart
  opts.onEvent?.({
    type: 'vm_allocated',
    workId: work.id,
    sandboxId: sandbox.id,
    bootMs,
    reused,
  })

  // Refresh the server-side TTL on each work item so the sandbox
  // survives until the next turn. Only touch sandboxes we own; customer
  // BYO has its own lifecycle.
  if (weOwnIt) {
    await sandbox.setTimeout(sandboxIdleTtlSec).catch(() => { /* best-effort */ })
  }

  // Upload work context as a file - keeps the scoped env key out of the
  // exec command line.
  const ctx = JSON.stringify({
    environmentKey: opts.environmentKey,
    environmentId: opts.environmentId,
    sessionId,
    workId: work.id,
    ...(opts.anthropicBaseUrl ? { anthropicBaseUrl: opts.anthropicBaseUrl } : {}),
  })
  await sandbox.writeFile('/tmp/isorun-claude-work.json', ctx)

  const result = await sandbox.exec(
    'node /opt/isorun-claude-runner/runner.mjs',
    sessionTimeoutSec,
  )

  // Always log runner stderr (truncated) so diagnostics surface.
  if (result.stderr && result.stderr.trim()) {
    // eslint-disable-next-line no-console
    console.error(`[runner ${work.id}] stderr:\n${result.stderr.slice(0, 4000)}`)
  }

  if (result.exitCode !== 0) {
    // Don't drop the binding on a runner failure - Anthropic may retry
    // and the customer's filesystem state in the sandbox is still
    // intact. Just bubble up the error.
    throw new Error(
      `runner exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    )
  }

  opts.onEvent?.({
    type: 'work_completed',
    workId: work.id,
    durationMs: Date.now() - startedAt,
  })
  // Sandbox stays in `bindings` for the next work item. Server-side TTL
  // (set above) reaps it after the idle window if no more work arrives.
}

async function allocateSandbox(
  opts: OrchestratorOptions,
  overrideImage: string | undefined,
  sessionTimeoutSec: number,
): Promise<Sandbox> {
  return opts.isorun.create({
    image: overrideImage ?? opts.image,
    vcpus: opts.vcpus,
    memMiB: opts.memMiB,
    timeoutSec: sessionTimeoutSec + 60,
  })
}
