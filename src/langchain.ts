import { CODE_TOOL_DESCRIPTION, SHELL_TOOL_DESCRIPTION, createSession, type SessionOptions, type ToolSession } from './_tool-session.js'

/**
 * LangChain.js adapter. Returns LangChain tools backed by a single shared
 * Isorun sandbox, plus a `close()` to destroy it. Drop-in code-interpreter
 * tool for agent frameworks.
 *
 * @example
 * ```ts
 * import { ChatOpenAI } from '@langchain/openai'
 * import { createReactAgent } from '@langchain/langgraph/prebuilt'
 * import { isorunTools } from 'isorun/langchain'
 *
 * const { tools, close } = await isorunTools()
 * try {
 *   const agent = createReactAgent({ llm: new ChatOpenAI({ model: 'gpt-4o' }), tools })
 *   const res = await agent.invoke({ messages: [{ role: 'user', content: 'Print the first 100 primes.' }] })
 *   console.log(res.messages.at(-1)?.content)
 * } finally {
 *   await close()
 * }
 * ```
 *
 * Requires `@langchain/core` and `zod` (peer dependencies).
 */
export async function isorunTools(
  options: SessionOptions = {},
): Promise<{ tools: unknown[]; close: ToolSession['close'] }> {
  const { tool } = await import('@langchain/core/tools')
  const { z } = await import('zod')
  const session = createSession(options)

  const codeInterpreter = tool(async ({ code }: { code: string }) => session.runCode(code), {
    name: 'code_interpreter',
    description: CODE_TOOL_DESCRIPTION,
    schema: z.object({ code: z.string().describe('Python source to execute') }),
  })

  const shell = tool(async ({ command }: { command: string }) => session.runShell(command), {
    name: 'shell',
    description: SHELL_TOOL_DESCRIPTION,
    schema: z.object({ command: z.string().describe('Shell command to run') }),
  })

  return { tools: [codeInterpreter, shell], close: session.close }
}
