/**
 * Probe: in `onExpiry: 'replace'` the wrapper returns at its own deadline while
 * the abandoned call keeps running. Question — does that still-running call
 * still see the deadline abort on `exec.signal`, or has the `finally` that
 * restores the caller's signal already taken it away?
 *
 * Reads `exec.signal` twice: once at entry (what the tool captured), once after
 * its own long sleep (what the same `exec` object says now).
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as plugin from './lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function mount(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.logger.exporter({ levels: { default: 3 }, export: () => {} })
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
  return ctx
}

const observed = {}

const tool = defineContentToolFixture({
  name: 'slow_ignorer',
  description: 'ignores exec.signal and reads the same exec object again later',
  parameters: {},
  async execute(_args, exec) {
    observed.captured = exec.signal
    observed.abortedAtEntry = exec.signal.aborted
    observed.reason = exec.signal.reason?.message
    await sleep(300)
    observed.sameAfterwards = exec.signal === observed.captured
    observed.abortedAfterwards = exec.signal.aborted
    observed.reasonAfterwards = exec.signal.reason?.message
    observed.abortEventSeen = false
    return [{ type: 'text', text: 'late result' }]
  },
})

for (const onExpiry of ['cooperative', 'replace']) {
  for (const key of Object.keys(observed)) delete observed[key]
  const ctx = await mount({ perTool: { slow_ignorer: 60 }, onExpiry })
  ctx.tools.register(tool)
  const started = Date.now()
  const result = await ctx.tools.execute({ callId: 'c1', name: 'slow_ignorer', arguments: {}, signal: new AbortController().signal })
  const returnedAt = Date.now() - started
  await sleep(400) // let the abandoned branch finish
  console.log(`--- onExpiry=${onExpiry} ---`)
  console.log('  call returned at', returnedAt, 'ms; isError =', result.isError, '; code =', result.error?.info?.code)
  console.log('  tool captured a signal, aborted at entry:', observed.abortedAtEntry)
  console.log('  after its own 300ms sleep: same object =', observed.sameAfterwards,
    '| aborted =', observed.abortedAfterwards, '| reason =', JSON.stringify(observed.reasonAfterwards))
  console.log('  (reason seen at entry:', JSON.stringify(observed.reason), ')')
}
