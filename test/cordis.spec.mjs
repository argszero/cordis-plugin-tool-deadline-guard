/**
 * Wiring tests against a real Cordis context, a real `ToolRuntime` and a real
 * `tools/execute` waterfall — no hand-built registry and no stubbed seam.
 *
 * The control arm is what makes the rest evidence: with the plugin unmounted, a
 * tool that declares no `timeoutMs` and never settles leaves the call pending
 * for as long as the test is willing to look, and nothing anywhere reports it.
 * That is discussion #7339's shape ("long-horizon tasks stall with nothing in
 * the output"), and the plugin's whole claim is that a mount can close it.
 *
 * The suite pins four separate promises, because they fail independently:
 *
 *  - **the gap is real** (unmounted control arm);
 *  - **an expiry becomes a model-visible, retryable error** under this plugin's
 *    own code, naming the tool and the budget;
 *  - **nothing else moves**: a tool inside its budget keeps its own result, a
 *    tool that declares `timeoutMs` is left to the core policy, exempt and
 *    observed tools dispatch unchanged, and an upstream abort is never reported
 *    as this plugin's deadline;
 *  - **the honest limit is asserted rather than described**: a tool that ignores
 *    `exec.signal` cannot be stopped from this seam, so `cooperative` waits for
 *    it and only `replace` returns early — with the abandoned call still running,
 *    which is exactly why `replace` is not the default.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const text = (value) => [{ type: 'text', text: value }]

/**
 * Mount the registry, an optional post-execute observer, the plugin and a set of
 * fixture tools.
 * @param config - plugin mount configuration.
 * @param options - `mounted: false` leaves the plugin out (the control arm).
 */
async function mount(config = {}, options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const warnings = []
  // `levels.default` must admit WARN: cordis drops a message below the
  // exporter's level and the root logger defaults to INFO.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'warn') warnings.push(message.args.map(String).join(' ')) },
  })
  if (options.mounted !== false) {
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
  }
  return { ctx, warnings }
}

/** A cooperative tool: no declared budget, and it settles ONLY when aborted. */
function hangForever(seen) {
  return defineContentToolFixture({
    name: 'hang_forever',
    description: 'settles only when exec.signal aborts, and declares no timeoutMs',
    parameters: {},
    execute(_args, exec) {
      seen.signal = exec.signal
      if (exec.signal.aborted) return Promise.resolve(text('stopped cooperatively'))
      return new Promise((resolve) => { exec.signal.addEventListener('abort', () => { resolve(text('stopped cooperatively')) }) })
    },
  })
}

/** A tool that ignores `exec.signal` completely and just takes its time. */
function stubborn(seen, ms) {
  return defineContentToolFixture({
    name: 'stubborn',
    description: 'ignores exec.signal and returns after a fixed delay',
    parameters: {},
    async execute(_args, exec) {
      seen.signal = exec.signal
      await sleep(ms)
      seen.finished = true
      return text('finished on its own schedule')
    },
  })
}

/** A tool that publishes a budget of its own and settles on its own schedule. */
function selfTimed(seen, ms, declaredMs) {
  return defineContentToolFixture({
    name: 'self_timed',
    description: 'declares a timeoutMs of its own',
    parameters: {},
    timeoutMs: declaredMs,
    async execute(_args, exec) {
      seen.signal = exec.signal
      await sleep(ms)
      return text('done before my own declared budget')
    },
  })
}

const run = (ctx, name, signal, args = {}) => ctx.tools.execute({ callId: 'c1', name, arguments: args, signal })

const deadlineCode = (result) => result?.error?.info?.code

test('unmounted, a tool that declares no budget is dispatched with no deadline at all', async () => {
  // The defect, and the reason a mount is needed: nothing in the harness bounds
  // this call — the core policy's first line is `if (timeoutMs === undefined)
  // return next()`, and no diagnostic is produced either way.
  const seen = {}
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 40 }, { mounted: false })
  ctx.tools.register(hangForever(seen))
  const controller = new AbortController()
  const call = run(ctx, 'hang_forever', controller.signal)
  const outcome = await Promise.race([call.then(() => 'settled'), sleep(200).then(() => 'still-pending')])
  assert.equal(outcome, 'still-pending', 'with no deadline declared and no plugin mounted, the call simply never returns')
  assert.equal(seen.signal.aborted, false, 'and nothing has aborted the tool')
  assert.deepEqual(warnings, [], 'and nothing reports it — this is the silent stall')
  controller.abort()
  await call
})

test('an expired budget becomes a model-visible TOOL_DEADLINE_EXCEEDED the tool observed', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ mode: 'auto', defaultTimeoutMs: 40 })
  ctx.tools.register(hangForever(seen))
  const result = await run(ctx, 'hang_forever', new AbortController().signal)

  assert.equal(result.isError, true)
  // Asserted as a literal on purpose: the code is what a deployment routes on
  // and what a log reader greps for, so comparing it against this module's own
  // export would let the two drift together.
  assert.equal(deadlineCode(result), 'TOOL_DEADLINE_EXCEEDED')
  assert.equal(result.error.info.code, 'TOOL_DEADLINE_EXCEEDED')
  assert.notEqual('TOOL_TIMEOUT', deadlineCode(result), 'the core policy owns TOOL_TIMEOUT; this code must stay distinct')
  assert.equal(result.error.info.name, 'ToolDeadlineError')
  assert.match(result.error.message, /"hang_forever" timed out/)
  assert.match(result.error.message, /exceeded the 40ms deadline supplied by the tool-deadline-guard mount/)
  assert.match(result.error.message, /declares no timeoutMs of its own/)
  assert.match(result.content[0].text, /^Error: tool call to "hang_forever"/)
  assert.equal(seen.signal.aborted, true, 'the tool was actually aborted, not merely reported as failed')
  assert.equal(warnings.length, 1)
  // The diagnostic states the timing and nothing else: this seam cannot see
  // whether the tool read the signal, so it may not say that it did.
  assert.match(warnings[0], /"hang_forever" settled after \d+ms, past its 40ms budget/)
  assert.doesNotMatch(warnings[0], /observed the abort/)
})

test('a call that settles inside its budget keeps the tool own result, with no diagnostic', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 5000 })
  ctx.tools.register(selfTimed(seen, 10, 5000))
  const result = await run(ctx, 'self_timed', new AbortController().signal)
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, 'done before my own declared budget')
  assert.deepEqual(warnings, [], 'a bounded call is not an event')
})

test('a tool that declares its own timeoutMs is left to the core policy (applyTo default)', async () => {
  // The plugin must not arm a second deadline over a call the core policy owns —
  // two wrappers racing one budget would produce two contradictory codes.
  const seen = {}
  const { ctx } = await mount({ defaultTimeoutMs: 30 })
  ctx.tools.register(selfTimed(seen, 90, 100))
  const upstream = new AbortController().signal
  const result = await run(ctx, 'self_timed', upstream)
  assert.equal(result.isError, false, '90ms is longer than this mount budget, and still not this plugin business')
  assert.equal(seen.signal, upstream, 'the declared tool received the caller signal untouched')
})

test('applyTo all bounds a tool that declares its own budget, and closes the gap for deployments without the core policy', async () => {
  const seen = {}
  const { ctx } = await mount({ defaultTimeoutMs: 40, applyTo: 'all' })
  ctx.tools.register(selfTimed(seen, 300, 100))
  const result = await run(ctx, 'self_timed', new AbortController().signal)
  assert.equal(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED)
  assert.equal(seen.signal.aborted, true)
})

test('exempt and perTool are honoured per tool', async () => {
  // Both fixtures declare no budget of their own, so `applyTo` cannot be what
  // saves them: the only thing that can leave the exempt one alone is `exempt`.
  const seen = {}
  const exemptSeen = {}
  const { ctx } = await mount({ defaultTimeoutMs: 5000, perTool: { stubborn: 40 }, exempt: ['hang_forever'] })
  ctx.tools.register(stubborn(seen, 300))
  ctx.tools.register(hangForever(exemptSeen))

  const bounded = await run(ctx, 'stubborn', new AbortController().signal)
  assert.equal(deadlineCode(bounded), plugin.TOOL_DEADLINE_EXCEEDED, 'the per-tool budget wins over the default')

  // A cooperative tool is only reachable through an abort, so the caller's own
  // cancellation is what ends this call — and it must end as the caller's
  // cancellation, never as this mount's deadline.
  const controller = new AbortController()
  const exempted = run(ctx, 'hang_forever', controller.signal)
  await sleep(30)
  controller.abort()
  const outcome = await exempted
  assert.notEqual(deadlineCode(outcome), 'TOOL_DEADLINE_EXCEEDED', 'an exempt tool is never bounded by this mount')
  assert.equal(deadlineCode(outcome), TOOL_ABORTED, 'and the caller cancellation keeps its own outcome')
  assert.equal(exemptSeen.signal, controller.signal, 'an exempt tool receives the caller signal untouched, not a fused one')
})

test('cooperative mode does not abandon a tool that ignores its signal — the boundary, asserted', async () => {
  // The seam cannot kill same-process code. An expiry is converted only after
  // the tool reaches quiescence, so this call still takes as long as the tool.
  const seen = {}
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 40, onExpiry: 'cooperative' })
  ctx.tools.register(stubborn(seen, 300))
  const started = Date.now()
  const result = await run(ctx, 'stubborn', new AbortController().signal)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250, `cooperative mode waits for the tool (took ${elapsed}ms)`)
  assert.equal(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED, 'and still reports the expiry rather than the tool stale success')
  assert.equal(seen.finished, true)
  // The rule is the core policy's rule — a call that came back after the timer
  // fired is reported as a deadline failure — and the diagnostic says only that
  // it came back late, because a tool that ignores its signal is indistinguishable
  // here from one that honored it and returned a result of its own.
  assert.match(warnings.join('\n'), /"stubborn" settled after \d+ms, past its 40ms budget/)
})

test('replace mode returns at the deadline and lets the call keep running — the trade, asserted', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 40, onExpiry: 'replace' })
  ctx.tools.register(stubborn(seen, 300))
  const started = Date.now()
  const result = await run(ctx, 'stubborn', new AbortController().signal)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 150, `replace mode returns as soon as its timer fires (took ${elapsed}ms)`)
  assert.equal(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED)
  assert.equal(seen.finished, undefined, 'the tool had not finished when the model was told it failed')
  assert.match(warnings.join('\n'), /the call itself is still running unobserved/)
  await sleep(400)
  assert.equal(seen.finished, true, 'and it does finish, with nobody left listening')
})

test('an upstream abort is never reported as this plugin deadline', async () => {
  // The mirror image of the core policy's rule: only an expiry this mount caused
  // may wear its code. The caller's own cancellation keeps its own outcome.
  const seen = {}
  const { ctx } = await mount({ defaultTimeoutMs: 5000 })
  ctx.tools.register(hangForever(seen))
  const controller = new AbortController()
  const call = run(ctx, 'hang_forever', controller.signal)
  await sleep(30)
  controller.abort()
  const result = await call
  assert.notEqual(deadlineCode(result), 'TOOL_DEADLINE_EXCEEDED')
  assert.equal(result.isError, true)
  assert.equal(deadlineCode(result), TOOL_ABORTED)
})

test('a tool the registry does not know is the registry business, not this plugin', async () => {
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 40 })
  const result = await run(ctx, 'no_such_tool', new AbortController().signal)
  assert.equal(result.isError, true)
  assert.notEqual(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED)
  assert.deepEqual(warnings, [])
})

test('post-execute sees the caller signal restored, never this plugin deadline signal', async () => {
  const { ctx } = await mount({ defaultTimeoutMs: 40 })
  const seen = {}
  ctx.tools.register(hangForever(seen))
  const observed = []
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    observed.push({ aborted: exec.signal.aborted, own: exec.signal === upstream })
    return next()
  })
  const upstream = new AbortController().signal
  const result = await run(ctx, 'hang_forever', upstream)
  assert.equal(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].aborted, false, 'the already-aborted deadline signal must not leak downstream')
  assert.equal(observed[0].own, true, 'and the caller signal is what post-execute sees')
})

test('mode observe reports what it would bound and dispatches unchanged', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ mode: 'observe', defaultTimeoutMs: 40, applyTo: 'all' })
  ctx.tools.register(selfTimed(seen, 90, 5000))
  const upstream = new AbortController().signal
  const result = await run(ctx, 'self_timed', upstream)
  assert.equal(result.isError, false, 'observe never bounds anything')
  assert.equal(seen.signal, upstream)
  assert.match(warnings[0], /would bound "self_timed" at 40ms .*dispatching unchanged/)
})

test('mode off registers nothing at all', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ mode: 'off', defaultTimeoutMs: 40 })
  ctx.tools.register(selfTimed(seen, 60, 5000))
  const upstream = new AbortController().signal
  const result = await run(ctx, 'self_timed', upstream)
  assert.equal(result.isError, false)
  assert.equal(seen.signal, upstream)
  assert.deepEqual(warnings, [])
})

test('diagnostics are bounded by warnLimit and silenced by 0', async () => {
  const seen = {}
  const { ctx, warnings } = await mount({ defaultTimeoutMs: 30, warnLimit: 1, perTool: { hang_forever: 30, stubborn: 30 } })
  ctx.tools.register(hangForever(seen))
  ctx.tools.register(stubborn(seen, 200))
  await run(ctx, 'hang_forever', new AbortController().signal)
  await run(ctx, 'stubborn', new AbortController().signal)
  assert.equal(warnings.length, 1, 'one mount, one warning')

  const quiet = {}
  const silent = await mount({ defaultTimeoutMs: 30, warnLimit: 0 })
  silent.ctx.tools.register(hangForever(quiet))
  const result = await run(silent.ctx, 'hang_forever', new AbortController().signal)
  assert.equal(deadlineCode(result), plugin.TOOL_DEADLINE_EXCEEDED, 'silencing diagnostics changes nothing else')
  assert.deepEqual(silent.warnings, [])
})

test('two calls in flight are bounded independently', async () => {
  const seen = {}
  const { ctx } = await mount({ defaultTimeoutMs: 40, perTool: { stubborn: 250 } })
  ctx.tools.register(hangForever(seen))
  ctx.tools.register(stubborn(seen, 500))
  const [quick, slow] = await Promise.all([
    run(ctx, 'hang_forever', new AbortController().signal),
    run(ctx, 'stubborn', new AbortController().signal),
  ])
  assert.equal(deadlineCode(quick), plugin.TOOL_DEADLINE_EXCEEDED)
  assert.equal(deadlineCode(slow), plugin.TOOL_DEADLINE_EXCEEDED)
})
