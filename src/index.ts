/**
 * Deployment-level deadlines for tool calls that declare none.
 *
 * ## The gap
 *
 * A tool call is bounded exactly when its definition says so. `ToolDefinition`
 * carries an optional `timeoutMs` ("Cooperative tool-call timeout budget in
 * milliseconds. Omit for no deadline") and the contract is stated in the same
 * docstring: the tool declares it, and
 * `@deepseek-ai/dsh-tool-call-timeout-policy` — a `tools/execute` wrapper — arms
 * the deadline on `exec.signal`. Omit the field and **nothing arms anything**:
 * the policy's own first line is `if (timeoutMs === undefined) return next()`.
 *
 * That omission is not rare. Of the source files calling `defineTool(` in the
 * harness at `dsh-v0.1.6-alpha.2`, 25 of 39 contain no `timeoutMs` at all —
 * including `tool-subagent` (delegation), `mcp-resources` (third-party MCP
 * tools), `tool-terminal`, `tool-ask-user`, the fs read/write/edit tools, and
 * `workflow`/`ralph`/`todo`/`plan-mode`. Two of those are exactly where a
 * long-horizon run spends its time: a delegation whose child never settles, and
 * a tool owned by someone else's server.
 *
 * The failure mode is not an error. It is a turn that keeps rendering as
 * running, with no diagnostic anywhere: if the model call stalls, the provider
 * adapters announce it (`DEFAULT_STREAM_IDLE_TIMEOUT_MS` = 300_000, armed per
 * chunk by `idleWatchdog`), so **silence** is the signature of a wedged tool
 * call rather than a wedged model call. Reported as discussion #7339
 * ("long-horizon tasks stall with nothing in the output"), and adjacent to
 * #6226 (a foreground `subagent` call whose child process had already exited).
 *
 * ## The other half: a call can hang before it is ever dispatched
 *
 * `timeoutMs` bounds the *body*. It cannot bound the phase that runs before the
 * body, and nothing else does either: the core policy is a `tools/execute`
 * wrapper, so the `tools/pre-execute` waterfall completes before it is reached.
 * A listener there that awaits unbounded work therefore stalls every call in the
 * session with no timer anywhere in the tree — and a deadline mounted on
 * `tools/execute` is *structurally* unable to see it, because that waterfall is
 * never entered.
 *
 * That is not hypothetical. `@deepseek-ai/dsh-workspace-changes` awaits the
 * turn recorder's snapshot queue inside `tools/pre-execute` before calling
 * `next()` (`packages/deliverables/workspace-changes/src/index.ts:174-182`), and
 * every tool call in the session waits behind it — so when the recorder's git
 * subprocess is the thing that wedged, the pending tool call names the tool
 * while the wedge is somewhere else entirely. Reported that way in #9515 (git
 * checkpoints among the wedging channels).
 *
 * ## What this plugin does
 *
 * It supplies the missing budget on both seams, and they are complementary:
 *
 * 1. **`tools/pre-execute` — the phase before dispatch.** A deadline there
 *    denies the call, so the tool body never runs: no side effects, no orphan
 *    `tool/call`, and a clean model-visible error the loop already knows how to
 *    carry (`PreToolDecision`'s `deny`). This arm is mounted `prepend: true`, so
 *    its race encloses every other pre-execute listener whichever order the two
 *    are mounted in (measured both ways).
 * 2. **`tools/execute` — the body.** It arms only where the harness arms
 *    nothing: by default (`applyTo: 'undeclared'`) a tool that declares
 *    `timeoutMs` is dispatched untouched, because the core policy already owns
 *    that call and two wrappers racing over one budget produce two contradictory
 *    error codes.
 * 3. **It is reactive in the only sense that matters here: no expiry, no
 *    change.** A call that settles inside its budget is returned exactly as the
 *    tool returned it — same object, no re-dispatch, no extra work.
 * 4. **An expired budget is a model-visible, retryable failure, not a hang.**
 *    The replacement result is the shape the loop already understands:
 *    `isError: true` with `error.info.code === 'TOOL_DEADLINE_EXCEEDED'` — the
 *    same construction the core policy uses for `TOOL_TIMEOUT`, under a code
 *    this plugin owns, so a deployment can tell "the tool declared a budget and
 *    blew it" from "this mount supplied a budget the tool never declared". The
 *    pre-execute arm has its own code for the same reason.
 *
 * Neither arm ends the underlying wedge: the zombie subprocess, the lost IPC
 * start — those keep running and are the deployment's to clear (#9515's own
 * recovery was killing the stuck runner). What both arms do is stop the *call*
 * from being the thing that never ends, so the turn continues and the log says
 * why.
 *
 * ## The honest limit: it does not race by default
 *
 * `timeoutMs` is a *cooperative* contract — declaring it asserts that the tool
 * forwards `exec.signal` to an implementation that can reach quiescence when the
 * signal aborts. A tool that ignores its signal cannot be fixed from this seam:
 * the wrapper awaits the tool's own promise, and "a tool that never settles"
 * means the wrapper never settles either. So in the default `onExpiry:
 * 'cooperative'` mode, an expiry is converted into the structured error **after
 * the call has settled** — which is what keeps the harness invariant that a
 * committed tool result corresponds to work that has stopped — and never before.
 *
 * What this seam cannot see is *why* the call settled. A tool that honors the
 * signal returns an abort artifact; a tool that ignores it and finishes anyway
 * returns its own late result; both arrive as "the promise resolved after our
 * timer fired". The core policy resolves that ambiguity by contract — the tool
 * author declared `timeoutMs`, so the tool promised to stop — and this plugin
 * resolves it the same way for a tool that declared nothing, which is a promise
 * the *deployment* is making on the tool's behalf. Measured on a deliberately
 * stubborn fixture (`probe-tools.mjs`, 60ms budget): the call returned at 402ms
 * with its own successful result, which the deadline failure replaced. A tool
 * whose late result matters must be listed in `exempt`.
 *
 * `onExpiry: 'replace'` is the mode for a deployment that would rather have a
 * usable turn than an unbroken invariant: the wrapper returns the deadline error
 * as soon as its timer fires and lets the call keep running, unobserved. Read
 * the note on {@link Config.onExpiry} before choosing it — it does **not** leave
 * an orphan `tool/call` in the log (the registry still commits a `tool/result`
 * for the call, ours), but it does let a tool's side effects happen after the
 * model was told it failed.
 *
 * @module @argszero/cordis-plugin-tool-deadline-guard
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDispatchExecution, ToolErrorInfo, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** The error code this plugin owns, on the replacement result and in diagnostics. */
export const TOOL_DEADLINE_EXCEEDED = 'TOOL_DEADLINE_EXCEEDED'

/** The structured error name carried by {@link TOOL_DEADLINE_EXCEEDED} results. */
export const DEADLINE_ERROR_NAME = 'ToolDeadlineError'

/**
 * The code the pre-dispatch arm denies under.
 *
 * Separate from {@link TOOL_DEADLINE_EXCEEDED} on purpose: the two say different
 * things. This one means the tool body **never ran**, so nothing it would have
 * done has happened and the call is safe to consider pure. The execute arm's
 * code means the body did run and did not finish inside its budget.
 */
export const TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED = 'TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED'

/** The structured error name carried by pre-dispatch denials. */
export const PRE_EXECUTE_ERROR_NAME = 'ToolPreExecuteDeadlineError'

/** How the wrapper treats a tool whose definition already declares a budget. */
export type ApplyTo = 'undeclared' | 'all'

/** What the wrapper does when its own timer fires. */
export type OnExpiry = 'cooperative' | 'replace'

/** How the plugin behaves on a call it could bound. */
export type Mode = 'off' | 'observe' | 'auto'

/** Plugin configuration. Every field is optional; see {@link resolveConfig}. */
export interface Config {
  /** `auto` (default) arms deadlines; `observe` only reports them; `off` does nothing. */
  mode?: Mode
  /** Budget for a tool that declares none, in milliseconds. Default 600000 (10 minutes). */
  defaultTimeoutMs?: number
  /** Per-tool budgets, keyed by the tool's resolved name; wins over `defaultTimeoutMs`. */
  perTool?: Record<string, number>
  /** Tool names this mount never bounds, whatever else is configured. */
  exempt?: string[]
  /** `undeclared` (default) leaves a tool that declares `timeoutMs` to the core policy; `all` bounds every known tool. */
  applyTo?: ApplyTo
  /** What an expiry does. Default `cooperative`; see the module note before using `replace`. */
  onExpiry?: OnExpiry
  /** Bound the phase before dispatch (`tools/pre-execute`) as well. Default `true`; see the module note. */
  preExecute?: boolean
  /** Budget for the pre-dispatch phase, in milliseconds. Default `defaultTimeoutMs`. */
  preExecuteTimeoutMs?: number
  /** Maximum diagnostics emitted per mount; `0` silences them. Default 5. */
  warnLimit?: number
}

/** {@link Config} with every default filled and every value validated. */
export interface ResolvedConfig {
  readonly mode: Mode
  readonly defaultTimeoutMs: number
  readonly perTool: Readonly<Record<string, number>>
  readonly exempt: ReadonlySet<string>
  readonly applyTo: ApplyTo
  readonly onExpiry: OnExpiry
  readonly preExecute: boolean
  readonly preExecuteTimeoutMs: number
  readonly warnLimit: number
}

/** The plugin name used by the mount patch. */
export const name = 'tool-deadline-guard'

/** This plugin wraps the tool registry's dispatch waterfall and reads its definitions. */
export const inject = ['tools']

/** Runtime schema for {@link Config}; cordis applies it before {@link apply}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'observe', 'auto']).default('auto'),
  defaultTimeoutMs: z.number().default(600000),
  perTool: z.dict(z.number()).default({}),
  exempt: z.array(z.string()).default([]),
  applyTo: z.union(['undeclared', 'all']).default('undeclared'),
  onExpiry: z.union(['cooperative', 'replace']).default('cooperative'),
  preExecute: z.boolean().default(true),
  preExecuteTimeoutMs: z.number(),
  warnLimit: z.number().default(5),
})

const MODES: readonly Mode[] = ['off', 'observe', 'auto']
const APPLY_TO: readonly ApplyTo[] = ['undeclared', 'all']
const ON_EXPIRY: readonly OnExpiry[] = ['cooperative', 'replace']

/** Thrown for a configuration {@link Config} cannot express but a caller can still pass. */
function invalid(detail: string): never {
  throw new Error(`${name}: ${detail}`)
}

/**
 * Assert one budget is a positive, finite number of milliseconds.
 *
 * The bound is deliberate: `setTimeout` saturates at 2^31-1 and would fire
 * immediately for anything larger, so an unbounded "budget" must be expressed by
 * omitting the tool from the plugin's scope rather than by asking for infinity.
 * @param label - the configuration path being validated, for the message.
 * @param value - the requested budget.
 * @returns the budget, unchanged.
 */
function validateBudget(label: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalid(`${label} must be a positive finite number of milliseconds, saw ${String(value)}`)
  }
  if (value > 2147483647) invalid(`${label} must not exceed 2147483647ms (setTimeout's saturation point), saw ${value}`)
  return value
}

/**
 * Fill every default so the wrapper can be reasoned about without Cordis, and
 * reject a configuration the runtime schema cannot express.
 * @param config - mount configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const mode = config.mode ?? 'auto'
  if (!MODES.includes(mode)) invalid(`unknown mode "${String(mode)}"`)
  const applyTo = config.applyTo ?? 'undeclared'
  if (!APPLY_TO.includes(applyTo)) invalid(`unknown applyTo "${String(applyTo)}"`)
  const onExpiry = config.onExpiry ?? 'cooperative'
  if (!ON_EXPIRY.includes(onExpiry)) invalid(`unknown onExpiry "${String(onExpiry)}"`)
  const defaultTimeoutMs = validateBudget('defaultTimeoutMs', config.defaultTimeoutMs ?? 600000)
  const perTool: Record<string, number> = {}
  for (const [tool, budget] of Object.entries(config.perTool ?? {})) {
    perTool[tool] = validateBudget(`perTool["${tool}"]`, budget)
  }
  const exempt = config.exempt ?? []
  exempt.forEach((tool, index) => {
    if (typeof tool !== 'string' || tool.length === 0) invalid(`exempt[${index}] must be a non-empty tool name`)
  })
  const warnLimit = config.warnLimit ?? 5
  if (!Number.isInteger(warnLimit) || warnLimit < 0) invalid(`warnLimit must be a non-negative integer, saw ${warnLimit}`)
  const preExecute = config.preExecute ?? true
  if (typeof preExecute !== 'boolean') invalid(`preExecute must be a boolean, saw ${String(preExecute)}`)
  // Defaults to the body budget rather than a second constant: a deployment that
  // has decided how long a tool may take has, by that decision, said how long
  // the phase in front of it may take. An explicit value overrides it alone.
  const preExecuteTimeoutMs = validateBudget('preExecuteTimeoutMs', config.preExecuteTimeoutMs ?? defaultTimeoutMs)
  return {
    mode,
    defaultTimeoutMs,
    perTool,
    exempt: new Set(exempt),
    applyTo,
    onExpiry,
    preExecute,
    preExecuteTimeoutMs,
    warnLimit,
  }
}

/**
 * The replacement result for one expired budget: the same construction the core
 * timeout policy uses, under this plugin's own code, with a message that names
 * the tool and the budget so a model (and a log reader) can tell what happened
 * without reading the plugin's configuration.
 * Deliberately says only what this seam knows. It cannot see whether the tool
 * read `exec.signal`, so the message reports the budget and its provenance and
 * makes no claim about what the tool did with the abort — the same shape the
 * core policy uses ("tool call timed out after Nms"), with the mount named
 * because for these tools no tool author ever agreed to a budget.
 * @param toolName - the tool whose budget expired.
 * @param budgetMs - the budget that expired.
 * @returns the model-facing failure result.
 */
export function deadlineResult(toolName: string, budgetMs: number): ToolExecutionResult {
  const message = `tool call to "${toolName}" timed out: it exceeded the ${budgetMs}ms deadline supplied by the tool-deadline-guard mount, and the tool declares no timeoutMs of its own`
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: DEADLINE_ERROR_NAME, code: TOOL_DEADLINE_EXCEEDED } },
  }
}

/**
 * The budget this mount would use for a resolved tool, or `undefined` when the
 * mount leaves the call alone. Pure: every decision the wrapper makes about
 * *whether* to arm is taken here, so a test can assert it without a timer.
 * @param toolName - the tool's resolved name.
 * @param declared - the tool's own `timeoutMs`, when it declares one.
 * @param config - the resolved mount configuration.
 * @returns the budget in milliseconds, or `undefined` to dispatch unchanged.
 */
export function budgetFor(
  toolName: string,
  declared: number | undefined,
  config: ResolvedConfig,
): number | undefined {
  if (config.mode === 'off') return undefined
  if (config.exempt.has(toolName)) return undefined
  if (declared !== undefined && config.applyTo === 'undeclared') return undefined
  return config.perTool[toolName] ?? config.defaultTimeoutMs
}

/**
 * The budget this mount would use for the phase *before* dispatch, or
 * `undefined` when it leaves that phase alone. Pure, like {@link budgetFor}.
 *
 * Deliberately narrower than {@link budgetFor}: no `declared` argument and no
 * `applyTo` check. A tool's `timeoutMs` is a contract about its **body**, and
 * the phase this arm bounds is the one that runs before the body — so a tool
 * that declares a budget still has an unbounded pre-dispatch phase, and
 * `applyTo: 'undeclared'` (which exists to stop this mount racing the core
 * policy over one body budget) has nothing to say about it. `perTool` is not
 * consulted either, for the same reason: it names a budget for the tool, and a
 * caller who wants this phase bounded differently sets `preExecuteTimeoutMs`.
 * @param toolName - the tool's resolved name.
 * @param config - the resolved mount configuration.
 * @returns the pre-dispatch budget in milliseconds, or `undefined` to leave the phase alone.
 */
export function preExecuteBudgetFor(toolName: string, config: ResolvedConfig): number | undefined {
  if (config.mode === 'off') return undefined
  if (!config.preExecute) return undefined
  if (config.exempt.has(toolName)) return undefined
  return config.preExecuteTimeoutMs
}

/**
 * The denial for one expired pre-dispatch phase.
 *
 * A `deny` rather than a result: at this seam the call has not been dispatched,
 * so there is no result to replace and nothing to abandon — declining the call
 * is what says the body never ran. `deny` is also the honest decision: this arm
 * cannot tell whether the wedged listener would have allowed or forbidden the
 * call, and running it after the fact is not something a deadline is entitled
 * to do.
 * @param toolName - the tool whose pre-dispatch phase expired.
 * @param budgetMs - the budget that expired.
 * @returns the pre-dispatch decision that keeps the call from being dispatched.
 */
export function preExecuteDenial(toolName: string, budgetMs: number): PreToolDecision {
  return {
    kind: 'deny',
    reason: `tool call to "${toolName}" was not dispatched: the pre-execute phase exceeded the ${budgetMs}ms deadline supplied by the tool-deadline-guard mount`,
    info: { name: PRE_EXECUTE_ERROR_NAME, code: TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED },
  }
}

/**
 * Register the deadline wrapper.
 *
 * Registration order is deliberately the default: this is a wrapper around the
 * tool body, and a listener registered later in the `tools/execute` waterfall
 * still runs *inside* every earlier one, so it composes with the core timeout
 * policy whichever way the two are mounted. What it must not do is arm a second
 * deadline for a call the core policy already bounds — hence `applyTo`.
 * @param ctx - the Cordis context carrying the `tools` service.
 * @param config - mount configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.mode === 'off') return

  let warnings = 0
  const reported = new Set<string>()

  /**
   * Emit one bounded diagnostic, at most once per distinct message.
   * @param message - the diagnostic text.
   */
  const report = (message: string): void => {
    if (message === undefined) return
    if (resolved.warnLimit === 0 || warnings >= resolved.warnLimit) return
    if (reported.has(message)) return
    reported.add(message)
    warnings += 1
    ctx.logger.warn(`${name}: ${message}`)
  }

  // Registered unconditionally, so the one place that decides whether this
  // phase is bounded is `preExecuteBudgetFor` — the same place the execute arm
  // decides, and the one a test can call without a timer. `mode: 'off'` has
  // already returned above.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const budget = preExecuteBudgetFor(exec.name, resolved)
    if (budget === undefined) return next()

    if (resolved.mode === 'observe') {
      report(`would bound the pre-execute phase of "${exec.name}" at ${budget}ms; dispatching unchanged`)
      return next()
    }

    let expire: () => void = () => {}
    const expiry = new Promise<void>((resolve) => { expire = resolve })
    const timer = setTimeout(expire, budget)
    // Both settling paths are captured into a value, so the abandoned phase
    // has no way to reach the host process: a phase that rejects after this
    // arm stopped waiting for it fails into a value nobody reads, rather than
    // into an unhandled rejection. That is why the capture is on the promise
    // this arm holds, not on a no-op handler added after the race.
    const chain: Promise<{ kind: 'decision', decision: PreToolDecision } | { kind: 'threw', error: unknown }> = next().then(
      (decision): { kind: 'decision', decision: PreToolDecision } => ({ kind: 'decision', decision }),
      (error: unknown): { kind: 'threw', error: unknown } => ({ kind: 'threw', error }),
    )
    const outcome = await Promise.race([
      chain,
      expiry.then((): { kind: 'expired' } => ({ kind: 'expired' })),
    ])
    clearTimeout(timer)

    if (outcome.kind === 'expired') {
      report(`"${exec.name}" was not dispatched: the pre-execute phase exceeded ${budget}ms (the phase itself is still running unobserved)`)
      return preExecuteDenial(exec.name, budget)
    }
    // A phase that failed on its own is not a deadline: the registry's own
    // error path owns it, and reporting it as this mount's expiry would hide
    // whatever the listener actually said.
    if (outcome.kind === 'threw') throw outcome.error
    return outcome.decision
  }, { prepend: true })

  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    // A tool the registry does not know: `UNKNOWN_TOOL` is the registry's to
    // report, and there is no definition to weigh a budget against anyway.
    const definition = ctx.tools.get(exec.name, exec.agent)
    if (definition === undefined) return next()
    const budget = budgetFor(exec.name, definition.timeoutMs, resolved)
    if (budget === undefined) return next()

    if (resolved.mode === 'observe') {
      report(`would bound "${exec.name}" at ${budget}ms (it declares ${definition.timeoutMs === undefined ? 'no timeoutMs' : `${definition.timeoutMs}ms`}); dispatching unchanged`)
      return next()
    }

    const own = new AbortController()
    let expired = false
    let expire: () => void = () => {}
    const expiry = new Promise<void>((resolve) => { expire = resolve })
    const timer = setTimeout(() => {
      expired = true
      expire()
      // A deadline abort carries the reason, so a cooperative tool that inspects
      // it sees something more useful than a bare AbortError.
      own.abort(new Error(`${name}: ${exec.name} exceeded its ${budget}ms deadline`))
    }, budget)

    const upstream = exec.signal
    exec.signal = AbortSignal.any([upstream, own.signal])
    const started = Date.now()
    try {
      if (resolved.onExpiry === 'replace') {
        // The race is the whole point of this mode: return as soon as the budget
        // expires, without waiting for the call. Both settling paths of the call
        // are captured into a value before the race, so the branch that is left
        // running cannot reach the host process as an unhandled rejection.
        const outcome = await Promise.race([
          next().then(result => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'threw' as const, error })),
          expiry.then(() => ({ kind: 'expired' as const })),
        ])
        if (outcome.kind === 'expired') {
          report(`"${exec.name}" exceeded ${budget}ms and was replaced (onExpiry: replace); the call itself is still running unobserved`)
          return deadlineResult(exec.name, budget)
        }
        if (outcome.kind === 'threw') throw outcome.error
        return outcome.result
      }

      const result = await next()
      // `expired` is read only after the tool settled. Two facts are known here:
      // the timer fired, and the call came back after it did. Whether the abort
      // is *why* it came back cannot be observed from this seam — a tool that
      // honors its signal returns an abort artifact, one that ignores it returns
      // its own late result — so the structured deadline failure replaces either
      // (the core policy's rule for a tool that declares a budget, applied to a
      // tool that declared none) and the diagnostic claims only the timing.
      if (expired) {
        report(`"${exec.name}" settled after ${Date.now() - started}ms, past its ${budget}ms budget; its result was replaced`)
        return deadlineResult(exec.name, budget)
      }
      return result
    } finally {
      clearTimeout(timer)
      // Restore the caller's own signal: post-execute listeners and every later
      // wrapper must never see this mount's (possibly already-aborted) deadline.
      exec.signal = upstream
    }
  })
}
