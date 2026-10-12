/**
 * Probe: what does a real ToolRuntime accept, and what does a `tools/execute`
 * wrapper see? Run against the installed `@deepseek-ai/dsh-tools`.
 *
 * Note the mount order: `ToolRuntime` resolves a `systemPrompt` dependency, so a
 * bare `ctx.plugin(ToolRuntime)` leaves `ctx.tools` undefined and the first
 * `register` throws. This probe used to do exactly that, and needed the fixture
 * API rather than a hand-written `parameters` shape — a hand-written one must
 * spell out `additionalProperties`, which is the registry's own schema rule.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

const seen = []
ctx.on('tools/execute', async (exec, next) => {
  seen.push({
    name: exec.name,
    hasSignal: exec.signal instanceof AbortSignal,
    agent: exec.agent === undefined ? 'none' : 'set',
    timeoutMs: ctx.tools.get(exec.name, exec.agent)?.timeoutMs,
  })
  return next()
})

ctx.tools.register(defineContentToolFixture({
  name: 'probe_tool',
  description: 'probe',
  parameters: {},
  execute: async (_args, exec) => {
    seen.push({ body: true, aborted: exec.signal.aborted })
    await sleep(5)
    return [{ type: 'text', text: 'ok' }]
  },
}))

console.log('registered:', ctx.tools.get('probe_tool') !== undefined)
const result = await ctx.tools.execute({ callId: 'c1', name: 'probe_tool', arguments: {}, signal: new AbortController().signal })
console.log('result:', JSON.stringify(result))
console.log('seen:', JSON.stringify(seen, null, 1))
