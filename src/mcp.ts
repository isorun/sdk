import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { formatExecResult } from './_tool-session.js'
import { Isorun, type Sandbox } from './index.js'

export interface McpServerOptions {
  /** API key. Defaults to the `ISORUN_API_KEY` env var. */
  apiKey?: string
  /** Bring your own client (overrides `apiKey`). */
  isorun?: Isorun
}

/**
 * Build an MCP server exposing the canonical Isorun primitives as tools:
 * create_sandbox, exec, url, hibernate, resume, checkpoint, restore,
 * list_sandboxes, destroy_sandbox. Returns the server unbound, so you can
 * connect it to stdio (see the `isorun-mcp` CLI) or compose it with your own.
 *
 * Requires `@modelcontextprotocol/sdk` and `zod` (peer dependencies).
 */
export async function buildServer(options: McpServerOptions = {}): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { z } = await import('zod')
  const ownsClient = !options.isorun
  const client = options.isorun ?? new Isorun(options.apiKey ? { apiKey: options.apiKey } : {})
  const server = new McpServer({ name: 'isorun', version: '1.0.0' })

  // Close the client we created when the server shuts down, so its pooled
  // connections don't keep the process alive. A caller-provided client is theirs.
  if (ownsClient) {
    const underlying = server.server
    const prevOnClose = underlying.onclose
    underlying.onclose = () => {
      prevOnClose?.()
      client.close()
    }
  }

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
  const fmt = formatExecResult
  const get = async (id: string): Promise<Sandbox | null> => client.get(id)

  server.registerTool(
    'create_sandbox',
    {
      description: 'Boot a fresh VM sandbox and return its ID.',
      inputSchema: {
        image: z.string().optional().describe('OCI image. Default: node:22-slim.'),
        vcpus: z.number().int().optional(),
        memMiB: z.number().int().optional(),
        diskMiB: z.number().int().optional(),
        timeoutSec: z.number().int().optional().describe('Idle auto-destroy seconds.'),
      },
    },
    async (args) => {
      const sb = await client.create(args)
      return text(sb.id)
    },
  )

  server.registerTool(
    'exec',
    {
      description: 'Run a command in a sandbox. Returns stdout, stderr, and exit code.',
      inputSchema: {
        sandboxId: z.string(),
        command: z.string(),
        timeoutSec: z.number().int().optional(),
      },
    },
    async ({ sandboxId, command, timeoutSec }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}. Call create_sandbox first.`)
      return text(fmt(await sb.exec(command, timeoutSec ?? 60)))
    },
  )

  server.registerTool(
    'url',
    {
      description: 'Public HTTPS URL for a port the sandbox is listening on.',
      inputSchema: { sandboxId: z.string(), port: z.number().int(), path: z.string().optional() },
    },
    async ({ sandboxId, port, path }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}.`)
      return text(sb.url(port, path))
    },
  )

  server.registerTool(
    'hibernate',
    { description: 'Pause a sandbox to disk; costs nothing while hibernated.', inputSchema: { sandboxId: z.string() } },
    async ({ sandboxId }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}.`)
      await sb.hibernate()
      return text('hibernated')
    },
  )

  server.registerTool(
    'resume',
    { description: 'Bring a hibernated sandbox back to running.', inputSchema: { sandboxId: z.string() } },
    async ({ sandboxId }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}.`)
      await sb.resume()
      return text('running')
    },
  )

  server.registerTool(
    'checkpoint',
    { description: 'Snapshot a running sandbox; returns a snapshot ID.', inputSchema: { sandboxId: z.string() } },
    async ({ sandboxId }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}.`)
      const snap = await sb.snapshot()
      return text(snap.id)
    },
  )

  server.registerTool(
    'restore',
    { description: 'Create a new sandbox from a snapshot ID; returns the new sandbox ID.', inputSchema: { snapshotId: z.string() } },
    async ({ snapshotId }) => {
      const sb = await client.restore(snapshotId)
      return text(sb.id)
    },
  )

  server.registerTool(
    'list_sandboxes',
    { description: 'List active sandbox IDs for the API key.', inputSchema: {} },
    async () => {
      const list = await client.list()
      return text(list.map((s) => s.id).join('\n') || '(none)')
    },
  )

  server.registerTool(
    'destroy_sandbox',
    { description: 'Destroy a sandbox and return usage stats.', inputSchema: { sandboxId: z.string() } },
    async ({ sandboxId }) => {
      const sb = await get(sandboxId)
      if (!sb) return err(`No sandbox ${sandboxId}.`)
      return text(JSON.stringify(await sb.destroy()))
    },
  )

  return server
}
