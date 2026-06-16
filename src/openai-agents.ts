import { CODE_TOOL_DESCRIPTION, SHELL_TOOL_DESCRIPTION, createSession, type SessionOptions, type ToolSession } from './_tool-session.js'

/**
 * OpenAI Agents SDK adapter. Returns ready-to-use function tools backed by a
 * single shared Isorun sandbox, plus a `close()` to destroy it.
 *
 * @example
 * ```ts
 * import { Agent, run } from '@openai/agents'
 * import { isorunTools } from 'isorun/openai-agents'
 *
 * const { tools, close } = await isorunTools()
 * try {
 *   const agent = new Agent({
 *     name: 'coder',
 *     instructions: 'Write and run code to solve the user task.',
 *     tools,
 *   })
 *   const result = await run(agent, 'Compute 2**100.')
 *   console.log(result.finalOutput)
 * } finally {
 *   await close()
 * }
 * ```
 *
 * Requires `@openai/agents` and `zod` (peer dependencies).
 */
export async function isorunTools(
  options: SessionOptions = {},
): Promise<{ tools: unknown[]; close: ToolSession['close'] }> {
  const { tool } = await import('@openai/agents')
  const { z } = await import('zod')
  const session = createSession(options)

  const tools = [
    tool({
      name: 'code_interpreter',
      description: CODE_TOOL_DESCRIPTION,
      parameters: z.object({ code: z.string().describe('Python source to execute') }),
      execute: async ({ code }) => session.runCode(code),
    }),
    tool({
      name: 'shell',
      description: SHELL_TOOL_DESCRIPTION,
      parameters: z.object({ command: z.string().describe('Shell command to run') }),
      execute: async ({ command }) => session.runShell(command),
    }),
  ]

  return { tools, close: session.close }
}
