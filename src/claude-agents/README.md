# Claude Managed Agents on Isorun

Run [Anthropic Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) sessions inside isolated Isorun VMs. One VM per session, full Linux isolation.

## Architecture

```
                 work.claim                   sandbox.exec
Anthropic   ←─────────────────  Orchestrator  ─────────────→  Isorun VM
  queue                          (host)                       (per session)
                                                              │
                                                              └─ runner.mjs
                                                                 └─ handleItem(work)
                                                                    ├─ download skills
                                                                    ├─ run bash tools
                                                                    └─ post results
```

- **Host orchestrator** (`orchestrator.ts`): TypeScript process polling Anthropic's environment work queue (`WorkPoller`). Keeps an in-process `Map<sessionId, Sandbox>` so successive turns in the same session share one VM; a per-session promise lock serialises work items inside the worker process. For each claimed item, allocates (or re-uses) an Isorun VM, writes the work context to `/tmp/isorun-claude-work.json` via `sandbox.writeFile` (so the scoped env key never enters the exec argv), then invokes the runner via `sandbox.exec`. Refreshes `sandbox.setTimeout(idleTtl)` each turn; reaping is server-side. Drains in-flight sessions on SIGTERM.
- **In-VM runner** (`runner.ts` → `/opt/isorun-claude-runner/runner.mjs`): Reads + unlinks `/tmp/isorun-claude-work.json` (which carries `environmentKey`, `environmentId`, `sessionId`, `workId`), then calls `client.beta.environments.work.worker({ workdir: '/mnt/session', unrestrictedPaths: true, maxIdleMs: 15_000 }).handleItem(...)` exactly once, exits. Env-var fallback (`ANTHROPIC_*`) is only honoured for direct CLI invocation during development.
- **Base image** (`Dockerfile.base`): bash, unzip, tar, Node 22+, `@anthropic-ai/sdk` pre-installed at `/opt/isorun-claude-runner/node_modules`, `/mnt/session` workdir (matches Anthropic's cloud-container convention; outcomes graders look for deliverables under `/mnt/session/outputs`). Built once and reused across sessions.

## Quick start

1. In the [Anthropic Console](https://platform.claude.com), create a self-hosted environment and generate its environment key.
2. Run a worker pointed at that environment (full script under [Programmatic use](#programmatic-use)):

```bash
export ISORUN_API_KEY=isorun_live_...
export ANTHROPIC_ENVIRONMENT_ID=env_...
export ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-...
```

Then in your application code, create sessions normally:

```ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
})

const session = await client.beta.sessions.create({
  agent: AGENT_ID,
  environment_id: process.env.ANTHROPIC_ENVIRONMENT_ID,
})
```

Anthropic enqueues the work; your Isorun-backed worker picks it up; the session runs in a fresh VM.

## Programmatic use

```ts
import { Isorun } from 'isorun'
import { runOrchestrator } from 'isorun/claude-agents/orchestrator'

const ac = new AbortController()
process.once('SIGTERM', () => ac.abort())

await runOrchestrator({
  isorun: new Isorun(),
  environmentId: process.env.ANTHROPIC_ENVIRONMENT_ID!,
  environmentKey: process.env.ANTHROPIC_ENVIRONMENT_KEY!,
  image: 'docker.io/isorun/claude-agents:0.4.3',
  vcpus: 2,
  memMiB: 4096,
  signal: ac.signal,
})
```

## Security

The Anthropic **organization** API key is *never* injected into the VM. Only the scoped **environment key** (`sk-ant-oat01-…`) reaches the sandbox, and it arrives as a JSON file written through `sandbox.writeFile` (Isorun's file-upload channel, not the exec API) at `/tmp/isorun-claude-work.json`. The in-VM runner reads + unlinks that file before doing anything else, so the scoped key never appears in any exec argv that Isorun could record in its audit trail. See the Anthropic security docs for the shared-responsibility model.

Per-session VMs share no kernel, no filesystem, no memory. Filesystem state in session A is invisible to session B.
