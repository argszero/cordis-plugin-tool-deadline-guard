# @argszero/cordis-plugin-tool-deadline-guard

A cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
that puts a deadline on tool calls that declare none — the calls for which
nothing in the harness arms anything today.

```
input:  user        "keep working on the migration until it is done"
        assistant   tool_calls: [subagent(prompt="...") id=call-1]
        ⋯           nothing in the log, nothing on screen, turn still "running"
```

A tool call is bounded exactly when its own definition says so.
`ToolDefinition.timeoutMs` is optional ("Cooperative tool-call timeout budget in
milliseconds. Omit for no deadline"), and the core enforcer
(`@deepseek-ai/dsh-tool-call-timeout-policy`, mounted by the base bundle) opens
with `if (timeoutMs === undefined) return next()`. Omit the field and *nothing
arms anything* — not a timer, not a signal, not a diagnostic.

That omission is the norm rather than the exception. Of the 40 non-test source
files calling `defineTool(` at `dsh-v0.1.6-alpha.2`, **26 contain no `timeoutMs`
at all** — 25 shipped tool modules plus the test fixture helper — among them
`tool-subagent` (delegation), `mcp-resources` (tools owned by someone else's
server), `tool-terminal`, `tool-ask-user`, the fs read/write/edit tools, and
`tool-workflow` / `tool-ralph` / `tool-todo` / `plan-mode`. Two of those are
exactly where a long-horizon run spends its time: a delegation whose child never
settles, and a tool on the far side of a network boundary.

The symptom is not an error. It is a turn that keeps rendering as running with
nothing anywhere to explain it. Compare the model call: the provider adapters
announce a stall (`DEFAULT_STREAM_IDLE_TIMEOUT_MS` = 300_000, re-armed per chunk
by `idleWatchdog`), so **silence is the signature of a wedged tool call, not a
wedged model call**. Reported as discussion
[#7339](https://github.com/deepseek-ai/deepseek-harness/discussions/7339)
("long-horizon tasks stall with nothing in the output"), and adjacent to
[#6226](https://github.com/deepseek-ai/deepseek-harness/discussions/6226) (a
foreground `subagent` call whose child process had already exited).

Mounted, the same call ends with something the model can act on:

```
        tool_result [error] "tool call to "subagent" timed out: it exceeded the
                    600000ms deadline supplied by the tool-deadline-guard mount,
                    and the tool declares no timeoutMs of its own"
```

**0.2.0 adds the other half.** A call can also hang *before* it is dispatched,
where no declared budget and no `tools/execute` wrapper can reach it — see
[The other half](#the-other-half-a-call-that-hangs-before-it-is-dispatched). The
same mount now covers that phase too, under its own code
(`TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED`), so a deployment can tell a body that ran
too long from a body that never ran at all.

## Install

From the registry (`0.2.0`, the current npm release):

```sh
npm install @argszero/cordis-plugin-tool-deadline-guard
```

Or straight from this repository, which is where `0.2.1` lives — it is not on npm,
because the environment it is built in has no publishing credential:

```sh
dsh plugin --profile <profile> add "github:argszero/cordis-plugin-tool-deadline-guard#v0.2.1"
```

The git channel needs `lib/` to be **committed**, not merely built: a git
dependency is packed from the repository, so an ignored build output installs a
package with no entry point while the install verb still exits `0`. `0.2.1`
commits the build output and `test/packaging.spec.mjs` asserts both halves of that
contract. The npm tarball never showed the defect, because `prepublishOnly` runs
`tsc` before packing.

In a `cordis.yml` / profile bundle, add the row (or merge this package's
`cordis.patch.yml`, which contains the same one):

```yaml
- insert:
    - id: tool-deadline-guard
      name: '@argszero/cordis-plugin-tool-deadline-guard'
```

With no configuration it bounds every tool that declares no `timeoutMs` at ten
minutes and dispatches every other call untouched.

| field | default | meaning |
|-------|---------|---------|
| `mode` | `auto` | `auto` arms deadlines; `observe` reports what it *would* bound and dispatches unchanged; `off` registers nothing |
| `defaultTimeoutMs` | `600000` | budget for a tool that declares none (10 minutes) |
| `perTool` | `{}` | per-tool budgets by resolved tool name; wins over `defaultTimeoutMs` |
| `exempt` | `[]` | tool names this mount never bounds, whatever else is configured |
| `applyTo` | `undeclared` | `undeclared` leaves a tool that declares `timeoutMs` to the core policy; `all` bounds every known tool |
| `onExpiry` | `cooperative` | what an expiry does; see [Honest limits](#honest-limits) |
| `preExecute` | `true` | bound the phase *before* dispatch too; see [The other half](#the-other-half-a-call-that-hangs-before-it-is-dispatched) |
| `preExecuteTimeoutMs` | `defaultTimeoutMs` | budget for that phase |
| `warnLimit` | `5` | diagnostics emitted per mount; `0` silences them |

A budget must be a positive finite number ≤ 2147483647 (`setTimeout`'s
saturation point): a larger value would fire immediately, so "no deadline" is
expressed by leaving a tool out of scope — `exempt`, or `mode: off` — rather than
by asking for infinity.

## What it does, precisely

The plugin mounts on two documented public seams — `tools/execute` (the same one
the core policy uses) and `tools/pre-execute` (the phase in front of it) — and
for each dispatch:

1. **Resolves the tool's own definition** (`ctx.tools.get(exec.name, exec.agent)`)
   and decides whether to arm at all. An unknown tool is the registry's business
   (`UNKNOWN_TOOL`), and there is no definition to weigh a budget against.
2. **Arms one timer and one controller**, and hands the tool a fused signal
   (`AbortSignal.any([caller, own])`) through `exec.signal`, exactly as the core
   policy hands it its derived deadline.
3. **Restores the caller's signal in a `finally`**, so post-execute listeners and
   every later wrapper never see this mount's (possibly already-aborted) signal —
   the rule the core policy documents for the same reason.
4. **Substitutes a result only when its own timer fired.** A call that settles
   inside its budget returns the tool's own result object, unchanged: no
   re-dispatch, no wrapper, no diagnostic.
5. **Races the pre-dispatch phase on the same kind of timer** and denies the call
   if that phase is the thing that hung; a phase that settles inside its budget
   dispatches the call untouched, and a phase that fails on its own keeps the
   registry's own error path.

An expired body budget produces the shape the loop already understands —
`isError: true` with `error.info.code === 'TOOL_DEADLINE_EXCEEDED'` — under a
code **this plugin owns**, deliberately not the core policy's `TOOL_TIMEOUT`: a
deployment can then tell "the tool declared a budget and blew it" from "this
mount supplied a budget the tool never declared", which is the difference
between a tool bug and a deployment policy. `ToolTimeoutError`-style routing on
`TOOL_TIMEOUT` keeps working for declared tools and does not silently capture
these.

An expired **pre-dispatch** phase is a different fact, so it gets a different
code (`TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED`) and a different shape (`deny`, not a
replaced result). See the next section.

## The other half: a call that hangs before it is dispatched

`timeoutMs` bounds the *body*. It cannot bound the phase that runs in front of
the body, and nothing else does either: the core policy is a `tools/execute`
wrapper, so the `tools/pre-execute` waterfall completes before the policy is ever
reached. A listener there that awaits unbounded work therefore stalls **every**
call in the session with no timer anywhere in the tree — and a deadline mounted
on `tools/execute` is structurally unable to see it, because that waterfall is
never entered.

That is not hypothetical. `@deepseek-ai/dsh-workspace-changes` awaits the turn
recorder's snapshot queue inside `tools/pre-execute` before calling `next()`
(`packages/deliverables/workspace-changes/src/index.ts:174-182`), so every tool
call in the session waits behind it — and when the recorder's git subprocess is
the thing that wedged, the pending call names the *tool* while the wedge is
somewhere else entirely. Reported that way in
[#9515](https://github.com/deepseek-ai/deepseek-harness/discussions/9515) (git
checkpoints among the wedging channels).

Mounted, the same call is denied rather than left pending:

```
        tool_result [error] tool call to "subagent" was not dispatched: the
                    pre-execute phase exceeded the 600000ms deadline supplied
                    by the tool-deadline-guard mount
```

with `error.info.code === 'TOOL_PRE_EXECUTE_DEADLINE_EXCEEDED'`. The second code
is not decoration: it says the body **never ran**, so nothing the call would have
done has happened and the model may treat it as pure — which the body arm's code
cannot say, because there the body did run and did not finish.

Three things worth knowing before turning it on:

- **`applyTo` does not apply to this arm, on purpose.** That field exists to stop
  this mount racing the core policy over one *body* budget; a tool that declares
  `timeoutMs` still has an unbounded pre-dispatch phase, so it is bounded here
  like any other. `exempt` does apply.
- **`prepend: true` is what makes it order-independent.** Registered in the
  default position, a deadline mounted after a wedging listener would sit
  *inside* the wedge and never be reached at all; prepended, its race encloses
  whichever listeners are already there (both orders are exercised by the suite).
- **The phase is not cancelled, only abandoned.** Nothing can cancel same-process
  code, so the wedged listener keeps running while the model is told the call
  never happened. That is the honest shape of a deadline at this seam: it stops
  the *call* from being the thing that never ends. A listener whose rejection
  arrives after the denial is captured into a value, so it cannot surface as an
  unhandled rejection in the host process.
- **`preExecute: false`** turns the arm off for a deployment that would rather
  keep the pre-dispatch phase unbounded.

## Honest limits

**It does not race by default, so it cannot free a tool that ignores its
signal.** `timeoutMs` is a *cooperative* contract: declaring it asserts that the
tool forwards `exec.signal` to an implementation that reaches quiescence when the
signal aborts. A tool that never looks at its signal cannot be unblocked from
this seam — the wrapper awaits the tool's promise, and a promise that never
settles keeps the wrapper (and the turn) waiting. In `cooperative` mode an expiry
is therefore converted into the structured error **after the call has settled**,
which is what keeps the invariant that a committed `tool/result` corresponds to
work that has stopped, and never before. Measured on a fixture that ignores its
signal with a 60 ms budget (`probe-seam.mjs`): the call returned at 402 ms, and
only then did the wrapper report.

**It cannot see *why* a call settled.** A tool that honors the signal returns an
abort artifact; one that ignores it and finishes anyway returns its own late
result; both arrive here as "the promise resolved after the timer fired". The
core policy resolves that ambiguity by contract — the tool's author declared a
budget, so the tool promised to stop — and this plugin resolves it the same way
for a tool that declared nothing, which is a promise the *deployment* is making
on the tool's behalf. The consequence, stated plainly: a stubborn tool's late
successful result is replaced by the deadline failure. A tool whose late result
matters must be listed in `exempt`. The diagnostic claims only the timing
(`"x" settled after 402ms, past its 40ms budget; its result was replaced`) and
never asserts that the tool observed the abort, because this seam cannot know
that.

**`onExpiry: 'replace'` buys a usable turn with a weaker guarantee.** The wrapper
returns the deadline failure as soon as its timer fires and lets the call keep
running, unobserved. It does **not** leave an orphan `tool/call` in the log —
the loop records a `tool/result` for the call it dispatched, ours
(`packages/core/agent-loop/src/tool-calls.ts:282`), so the transcript stays
balanced and the next request is accepted; the abandoned call's rejection is
captured into a value, so it cannot surface as an unhandled rejection in the host
process. What it does do is let a tool's side effects happen **after** the model
was told the call failed, so a model that retries may duplicate them. For a tool
that never settles, this is the only mode that returns at all.

**`applyTo: 'all'` is for deployments without the core policy.** The base bundle
mounts `timeout-policy` unconditionally, so on a stock profile `undeclared` is
the correct default: two wrappers racing one budget would produce two
contradictory codes for one call. `all` exists for a composition that dropped the
policy — and for the case where a tool's declared budget is larger than the
deployment is willing to wait.

## Verifying it

```sh
npm test                    # tsc, then the wiring suite and the packaging guard
python3 mutations.py        # each claim above, broken one at a time, must go red
node probe-seam.mjs         # the body numbers above, against a real registry
node probe-pre-execute.mjs  # the pre-dispatch seam, with and without the arm
node probe-tools.mjs        # what a real ToolRuntime accepts and what a wrapper sees
node probe-peer-range.mjs   # the peer ranges, read the way npm and pnpm each read them
```

`test/cordis.spec.mjs` mounts a real Cordis context, a real `ToolRuntime` and a
real `tools/execute` waterfall, with **unmounted control arms** that demonstrate
both defects (with no plugin, a tool that declares no budget and never settles
stays pending; a listener that awaits unbounded work before `next()` holds the
call before the body runs — and nothing reports either). `mutations.py` edits the
*built* artifact — never the source — and requires the suite to fail for each of
its **eighteen** mutations, so a claim no test actually holds cannot pass
unnoticed; it also reports `NOT-APPLIED` when a mutation's anchor no longer
matches the build, which is the same failure one step earlier.
`test/packaging.spec.mjs` asserts both directions of the manifest against the
shipped imports (a runtime import declared only in `devDependencies` is a
consumer's `ERR_MODULE_NOT_FOUND`; a declared package never imported widens the
install closure for nothing) and pins the audited peer ranges.

## Compatibility

Requires `tools/execute`, `tools/pre-execute`, `ToolDispatchExecution`,
`PreToolDecision`, `ToolDefinition.timeoutMs` and `ctx.tools.get(name, agent)`,
all present in `@deepseek-ai/dsh-tools` from `0.1.2-rc.1` onward. The suite is run
against two lines besides its own build — `0.1.7-rc.2` (+ `cordis` 4.0.4) and
`0.2.1-alpha.2` (+ `cordis` 4.0.5-alpha.1); 26/26 each. `@deepseek-ai/cordis` is a
peer; `@deepseek-ai/schemastery` is the only runtime dependency.

The peer ranges are written as one explicit segment per release line, because a
prerelease range is read two ways: npm excludes a prerelease unless a comparator
in the range names the same version tuple, while pnpm passes `includePrerelease`
and admits more for the same string. A range that only names the line it was
written on therefore installs under one package manager and `ERESOLVE`s under the
other — with the divergence made of exactly the releases people run on.
`probe-peer-range.mjs` is the audit, and `test/packaging.spec.mjs` pins its
result.

## License

MIT
