import { Isorun, type Sandbox } from './index.js'

/**
 * Shared sandbox session used by the agent-framework adapters
 * (OpenAI Agents, LangChain). One sandbox is created lazily on first use
 * and reused across calls, so multi-turn state (cwd, env vars, installed
 * packages, files) persists. The idle timer is refreshed on every call so
 * the sandbox stays alive across agent turns.
 */
export interface SessionOptions {
  /** OCI image for the sandbox. Default: `python:3.12-slim`. */
  image?: string
  /** API key. Defaults to the `ISORUN_API_KEY` env var. */
  apiKey?: string
  /** Idle auto-destroy timeout in seconds. Default: 600. */
  timeoutSec?: number
  /** Bring your own client (overrides `apiKey`). */
  isorun?: Isorun
}

export interface ToolSession {
  runCode(code: string): Promise<string>
  runShell(command: string): Promise<string>
  /** Destroy the underlying sandbox. Safe to call more than once. */
  close(): Promise<void>
  /** The live sandbox, or null before the first call. */
  sandbox(): Sandbox | null
}

/** Render an exec result as a single LLM-friendly text block. */
export function formatExecResult(r: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout.replace(/\s+$/, ''))
  if (r.stderr) parts.push('STDERR:\n' + r.stderr.replace(/\s+$/, ''))
  if (r.exitCode !== 0) parts.push(`[exit code: ${r.exitCode}]`)
  return parts.length ? parts.join('\n') : '(no output)'
}

// Tool descriptions shared verbatim by the agent-framework adapters.
export const CODE_TOOL_DESCRIPTION =
  'Execute Python code in an isolated VM with internet ' +
  'access, pip, and a full Python environment. Returns stdout and stderr.'
export const SHELL_TOOL_DESCRIPTION =
  'Execute a shell command in the same isolated Linux sandbox. Use for ' +
  'installing packages, running scripts, git, curl, and file operations.'

export function createSession(options: SessionOptions = {}): ToolSession {
  const image = options.image ?? 'python:3.12-slim'
  const timeoutSec = options.timeoutSec ?? 600
  // Only close a client we created ourselves; a caller-provided one is theirs.
  const ownsClient = !options.isorun
  const client = options.isorun ?? new Isorun(options.apiKey ? { apiKey: options.apiKey } : {})
  let sb: Sandbox | null = null
  let closed = false

  async function ensure(): Promise<Sandbox> {
    if (!sb) sb = await client.create({ image, timeoutSec })
    return sb
  }
  async function keepAlive(s: Sandbox): Promise<void> {
    try {
      await s.setTimeout(timeoutSec)
    } catch {
      /* non-fatal */
    }
  }

  return {
    async runCode(code: string): Promise<string> {
      const s = await ensure()
      const b64 = Buffer.from(code, 'utf8').toString('base64')
      const r = await s.exec(`echo ${b64} | base64 -d > /tmp/_run.py && python3 /tmp/_run.py`, 60)
      await keepAlive(s)
      return formatExecResult(r)
    },
    async runShell(command: string): Promise<string> {
      const s = await ensure()
      const r = await s.exec(command, 60)
      await keepAlive(s)
      return formatExecResult(r)
    },
    async close(): Promise<void> {
      if (sb) {
        try {
          await sb.destroy()
        } catch {
          /* already gone */
        }
        sb = null
      }
      // Close the client we created so its pooled connections don't keep the
      // process alive after the session ends.
      if (ownsClient && !closed) {
        closed = true
        client.close()
      }
    },
    sandbox: () => sb,
  }
}
