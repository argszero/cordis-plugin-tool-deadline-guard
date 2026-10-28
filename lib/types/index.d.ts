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
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/** The error code this plugin owns, on the replacement result and in diagnostics. */
export declare const TOOL_DEADLINE_EXCEEDED = "TOOL_DEADLINE_EXCEEDED";
/** The structured error name carried by {@link TOOL_DEADLINE_EXCEEDED} results. */
export declare const DEADLINE_ERROR_NAME = "ToolDeadlineError";
/**
 * The code the pre-dispatch arm denies under.
 *
 * Separate from {@link TOOL_DEADLINE_EXCEEDED} on purpose: the two say different
 * things. This one means the tool body **never ran**, so nothing it would have
 * done has happened and the call is safe to consider pure. The execute arm's
 * code means the body did run and did not finish inside its budget.
 */
export declare const TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED = "TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED";
/** The structured error name carried by pre-dispatch denials. */
export declare const PRE_EXECUTE_ERROR_NAME = "ToolPreExecuteDeadlineError";
/** How the wrapper treats a tool whose definition already declares a budget. */
export type ApplyTo = 'undeclared' | 'all';
/** What the wrapper does when its own timer fires. */
export type OnExpiry = 'cooperative' | 'replace';
/** How the plugin behaves on a call it could bound. */
export type Mode = 'off' | 'observe' | 'auto';
/** Plugin configuration. Every field is optional; see {@link resolveConfig}. */
export interface Config {
    /** `auto` (default) arms deadlines; `observe` only reports them; `off` does nothing. */
    mode?: Mode;
    /** Budget for a tool that declares none, in milliseconds. Default 600000 (10 minutes). */
    defaultTimeoutMs?: number;
    /** Per-tool budgets, keyed by the tool's resolved name; wins over `defaultTimeoutMs`. */
    perTool?: Record<string, number>;
    /** Tool names this mount never bounds, whatever else is configured. */
    exempt?: string[];
    /** `undeclared` (default) leaves a tool that declares `timeoutMs` to the core policy; `all` bounds every known tool. */
    applyTo?: ApplyTo;
    /** What an expiry does. Default `cooperative`; see the module note before using `replace`. */
    onExpiry?: OnExpiry;
    /** Bound the phase before dispatch (`tools/pre-execute`) as well. Default `true`; see the module note. */
    preExecute?: boolean;
    /** Budget for the pre-dispatch phase, in milliseconds. Default `defaultTimeoutMs`. */
    preExecuteTimeoutMs?: number;
    /** Maximum diagnostics emitted per mount; `0` silences them. Default 5. */
    warnLimit?: number;
}
/** {@link Config} with every default filled and every value validated. */
export interface ResolvedConfig {
    readonly mode: Mode;
    readonly defaultTimeoutMs: number;
    readonly perTool: Readonly<Record<string, number>>;
    readonly exempt: ReadonlySet<string>;
    readonly applyTo: ApplyTo;
    readonly onExpiry: OnExpiry;
    readonly preExecute: boolean;
    readonly preExecuteTimeoutMs: number;
    readonly warnLimit: number;
}
/** The plugin name used by the mount patch. */
export declare const name = "tool-deadline-guard";
/** This plugin wraps the tool registry's dispatch waterfall and reads its definitions. */
export declare const inject: string[];
/** Runtime schema for {@link Config}; cordis applies it before {@link apply}. */
export declare const Config: z<Config>;
/**
 * Fill every default so the wrapper can be reasoned about without Cordis, and
 * reject a configuration the runtime schema cannot express.
 * @param config - mount configuration.
 * @returns the resolved configuration.
 */
export declare function resolveConfig(config?: Config): ResolvedConfig;
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
export declare function deadlineResult(toolName: string, budgetMs: number): ToolExecutionResult;
/**
 * The budget this mount would use for a resolved tool, or `undefined` when the
 * mount leaves the call alone. Pure: every decision the wrapper makes about
 * *whether* to arm is taken here, so a test can assert it without a timer.
 * @param toolName - the tool's resolved name.
 * @param declared - the tool's own `timeoutMs`, when it declares one.
 * @param config - the resolved mount configuration.
 * @returns the budget in milliseconds, or `undefined` to dispatch unchanged.
 */
export declare function budgetFor(toolName: string, declared: number | undefined, config: ResolvedConfig): number | undefined;
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
export declare function preExecuteBudgetFor(toolName: string, config: ResolvedConfig): number | undefined;
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
export declare function preExecuteDenial(toolName: string, budgetMs: number): PreToolDecision;
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
export declare function apply(ctx: Context, config?: Config): void;
