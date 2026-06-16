/**
 * Claude Managed Agents in-VM runner.
 *
 * Runs INSIDE the Isorun sandbox. Pre-baked into the base image at
 * /opt/isorun-claude-runner/runner.mjs. Reads the work-item context
 * from a host-uploaded JSON file at /tmp/isorun-claude-work.json
 * (unlinked immediately on read), handles exactly one session via the
 * Anthropic SDK's environment worker, then exits.
 *
 * Per the spec, this needs:
 *   /bin/bash at that exact path
 *   unzip, tar
 *   Node.js 22+
 *   @anthropic-ai/sdk installed at a known global location
 *
 * Reference: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
 */

import { readFileSync, unlinkSync } from 'node:fs'

export interface RunnerOptions {
  workdir?: string
  /** Override the work-context file path. Defaults to /tmp/isorun-claude-work.json. */
  workFile?: string
}

interface WorkContext {
  environmentKey: string
  environmentId: string
  sessionId: string
  workId: string
  anthropicBaseUrl?: string
}

/**
 * Handle exactly one Claude Managed Agents work item, then return.
 *
 * Reads the work context from /tmp/isorun-claude-work.json (uploaded
 * by the host orchestrator via sandbox.writeFile). Falls back to the
 * legacy ANTHROPIC_* env-var contract if the file is absent - useful
 * for direct CLI invocation during development.
 */
export async function runOneWorkItem(options: RunnerOptions = {}): Promise<void> {
  const workdir = options.workdir ?? '/mnt/session'
  const ctx = loadContext(options.workFile ?? '/tmp/isorun-claude-work.json')

  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({
    authToken: ctx.environmentKey,
    ...(ctx.anthropicBaseUrl ? { baseURL: ctx.anthropicBaseUrl } : {}),
    defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
    // `warn` keeps request-level chatter out of customer logs.
    logLevel: 'warn',
  })

  // unrestrictedPaths: the bash agent toolset's write/read/edit/glob/grep
  // tools default to rejecting absolute paths even when they fall inside
  // workdir, but agents routinely use `/mnt/session/outputs/foo.txt`-style
  // paths. The per-session sandbox already isolates the work, so absolute
  // paths inside it are not a confused-deputy risk.
  //
  // maxIdleMs: cap how long the runner waits for more agent events after
  // `session.status_idle end_turn` (SDK default 60s). 15s is long enough
  // that legitimate multi-step `tool_use → tool_result → ...` pauses don't
  // end the runner early, and short enough that a hung session doesn't pin
  // the sandbox.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beta = client.beta as any
  await beta.environments.work
    .worker({
      workdir,
      unrestrictedPaths: true,
      maxIdleMs: 15_000,
    })
    .handleItem({
      workId: ctx.workId,
      environmentId: ctx.environmentId,
      sessionId: ctx.sessionId,
      environmentKey: ctx.environmentKey,
    })
}

function loadContext(path: string): WorkContext {
  let raw: string | undefined
  try {
    raw = readFileSync(path, 'utf8')
    // Best-effort: remove the file before doing anything else so the
    // secret isn't lingering on disk longer than necessary. Tolerate
    // failure (read-only fs, missing perms).
    try { unlinkSync(path) } catch { /* noop */ }
  } catch {
    // Fall through to env-var fallback.
  }

  if (raw) {
    const parsed = JSON.parse(raw) as Partial<WorkContext>
    return {
      environmentKey: required(parsed.environmentKey, 'environmentKey'),
      environmentId: required(parsed.environmentId, 'environmentId'),
      sessionId: required(parsed.sessionId, 'sessionId'),
      workId: required(parsed.workId, 'workId'),
      anthropicBaseUrl: parsed.anthropicBaseUrl,
    }
  }

  return {
    environmentKey: requiredEnv('ANTHROPIC_ENVIRONMENT_KEY'),
    environmentId: requiredEnv('ANTHROPIC_ENVIRONMENT_ID'),
    sessionId: requiredEnv('ANTHROPIC_SESSION_ID'),
    workId: requiredEnv('ANTHROPIC_WORK_ID'),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`work context missing required field: ${name}`)
  }
  return value
}

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(`required env var ${name} is unset (and no work-context file present)`)
  }
  return v
}

const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /runner\.m?js$/.test(process.argv[1] ?? '')

if (isMain) {
  runOneWorkItem().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  })
}
