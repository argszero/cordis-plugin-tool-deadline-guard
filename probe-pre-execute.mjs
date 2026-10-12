/**
 * Seam probe — can a plugin bound the PRE-DISPATCH phase?
 *
 * Mimics `packages/deliverables/workspace-changes/src/index.ts:174-182`, which
 * awaits an unbounded recorder queue inside `tools/pre-execute` before calling
 * `next()`. If that queue is wedged the call never reaches `tools/execute`, so a
 * deadline mounted there cannot see it.
 *
 * Arms:
 *   A  control: no pre-execute deadline -> call stays pending, tool never runs
 *   B  deadline mounted AFTER the wedging listener (the hard ordering case)
 *   C  deadline mounted BEFORE the wedging listener
 *   D  the abandoned chain later REJECTS -> must not surface as an unhandled
 *      rejection inside the host process
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CODE = 'TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED'

/** The planned pre-execute arm, inlined so the seam is measured before it is written. */
function armPreExecDeadline(ctx, budget) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    let expire
    const expiry = new Promise((resolve) => { expire = resolve })
    const timer = setTimeout(() => expire('expired'), budget)
    const chain = next().then(
      (decision) => ({ kind: 'decision', decision }),
      (error) => ({ kind: 'threw', error }),
    )
    const outcome = await Promise.race([chain, expiry])
    clearTimeout(timer)
    if (outcome === 'expired') {
      chain.then(() => {}, () => {}) // abandoned: never let it surface later
      return {
        kind: 'deny',
        reason: `tool call to "${exec.name}" was not dispatched: the pre-execute phase exceeded the ${budget}ms deadline`,
        info: { name: 'ToolPreExecuteDeadlineError', code: CODE },
      }
    }
    if (outcome.kind === 'threw') throw outcome.error
    return outcome.decision
  }, { prepend: true })
}

async function scenario(label, { mounted, order, budget = 60, lateReject = false }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.logger.exporter({ levels: { default: 3 }, export: () => {} })

  if (mounted === true && order === 'deadline-before-wedge') armPreExecDeadline(ctx, budget)

  // The wedge: a promise that never settles, awaited before `next()`.
  let wedgingSignalSeen
  ctx.on('tools/pre-execute', async (exec, next) => {
    wedgingSignalSeen = exec.signal
    if (lateReject) {
      await sleep(250)
      throw new Error('recorder queue rejected after the deadline')
    }
    await new Promise(() => {})
    return next()
  })

  if (mounted === true && order === 'deadline-after-wedge') armPreExecDeadline(ctx, budget)

  const ran = { body: false }
  ctx.tools.register(defineContentToolFixture({
    name: 'probe_tool',
    description: 'records whether its body ever ran',
    parameters: {},
    execute() { ran.body = true; return [{ type: 'text', text: 'ran' }] },
  }))

  const started = Date.now()
  const call = ctx.tools.execute({ callId: 'c1', name: 'probe_tool', arguments: {}, signal: new AbortController().signal })
  const outcome = await Promise.race([call.then((r) => ({ r })), sleep(400).then(() => 'still-pending')])
  const elapsed = Date.now() - started
  console.log(`--- ${label} ---`)
  if (outcome === 'still-pending') {
    console.log(`  still-pending at ${elapsed}ms | tool body ran: ${ran.body}`)
  } else {
    const r = outcome.r
    console.log(`  settled at ${elapsed}ms | isError=${r.isError} | code=${r.error?.info?.code} | tool body ran: ${ran.body}`)
    console.log(`  text: ${r.content?.[0]?.text?.slice(0, 96)}`)
  }
  await sleep(350) // let any abandoned branch finish, and any unhandled rejection fire
  return outcome
}

process.on('unhandledRejection', (e) => { console.log('  !! UNHANDLED REJECTION:', String(e && e.message)) })

await scenario('A control: nothing bounds the pre-execute phase', { mounted: false })
await scenario('B deadline mounted AFTER the wedging listener', { mounted: true, order: 'deadline-after-wedge' })
await scenario('C deadline mounted BEFORE the wedging listener', { mounted: true, order: 'deadline-before-wedge' })
await scenario('D abandoned branch later rejects', { mounted: true, order: 'deadline-after-wedge', budget: 60, lateReject: true })
console.log('done')
