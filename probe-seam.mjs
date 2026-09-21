import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

const log = []
// The wrapper under test: swap exec.signal for our own fused signal, delegate,
// and replace the result when our own timer fired.
ctx.on('tools/execute', async (exec, next) => {
  const own = new AbortController()
  const fused = AbortSignal.any([exec.signal, own.signal])
  const upstream = exec.signal
  exec.signal = fused
  log.push({ phase: 'wrapper-entered', sameAsUpstream: fused === upstream })
  const timer = setTimeout(() => own.abort(new Error('DEADLINE')), 60)
  try {
    const result = await next()
    log.push({ phase: 'wrapper-settled', ownAborted: own.signal.aborted, toolSawAbort: lastSawAbort })
    if (own.signal.aborted) {
      return { isError: true, error: { message: 'deadline', info: { name: 'ToolDeadlineError', code: 'TOOL_DEADLINE_EXCEEDED' } }, content: [{ type: 'text', text: 'Error: deadline' }] }
    }
    return result
  } finally {
    clearTimeout(timer)
    exec.signal = upstream
    log.push({ phase: 'wrapper-restored', restored: exec.signal === upstream })
  }
})

let lastSawAbort = undefined
// A cooperative tool: it observes exec.signal and settles when aborted.
ctx.tools.register(defineTool({
  name: 'cooperative',
  description: 'cooperative',
  parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'ok' }] },
  execute: async (args, exec) => {
    const started = Date.now()
    while (!exec.signal.aborted && Date.now() - started < 5000) await sleep(10)
    lastSawAbort = exec.signal.aborted
    log.push({ phase: 'tool-exited', ms: Date.now() - started, aborted: exec.signal.aborted })
    return {}
  },
}))

// A tool that ignores its signal entirely.
let stubbornFinished = false
ctx.tools.register(defineTool({
  name: 'stubborn',
  description: 'stubborn',
  parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'ok' }] },
  execute: async () => { await sleep(400); stubbornFinished = true; return {} },
}))

const t0 = Date.now()
const a = await ctx.tools.execute({ callId: 'c1', name: 'cooperative', arguments: {}, signal: new AbortController().signal })
console.log('cooperative:', Date.now() - t0, 'ms |', JSON.stringify(a.error?.info ?? a))
const t1 = Date.now()
const b = await ctx.tools.execute({ callId: 'c2', name: 'stubborn', arguments: {}, signal: new AbortController().signal })
console.log('stubborn:', Date.now() - t1, 'ms |', JSON.stringify(b.error?.info ?? b), '| stubbornFinished =', stubbornFinished)
console.log('log:', JSON.stringify(log))
