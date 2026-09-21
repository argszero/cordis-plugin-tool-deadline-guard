/**
 * Probe: what does a real ToolRuntime accept, and what does a tools/execute
 * wrapper see? Run against the installed @deepseek-ai/dsh-tools.
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const ctx = new Context()
await ctx.plugin(ToolRuntime)

const seen = []
ctx.on('tools/execute', async (exec, next) => {
  seen.push({ name: exec.name, hasSignal: exec.signal instanceof AbortSignal, agent: exec.agent === undefined ? 'none' : 'set' })
  const budget = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
  seen.at(-1).timeoutMs = budget
  return next()
})

const dispose = ctx.tools.register(defineTool({
  name: 'probe_tool',
  description: 'probe',
  parameters: { shape: { type: 'object', properties: {} }, optional: [] },
  output: {
    schema: { type: 'object' },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async (args, exec) => {
    seen.push({ body: true, aborted: exec.signal.aborted })
    await sleep(5)
    return { ok: true }
  },
}))

console.log('registered:', ctx.tools.get('probe_tool') !== undefined)
const result = await ctx.tools.execute({ callId: 'c1', name: 'probe_tool', arguments: {}, signal: new AbortController().signal })
console.log('result:', JSON.stringify(result))
console.log('seen:', JSON.stringify(seen, null, 1))
dispose()
