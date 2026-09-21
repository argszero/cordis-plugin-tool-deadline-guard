"""Mutation harness for cordis-plugin-tool-deadline-guard.

Each mutation breaks one claim the suite makes, in the BUILT output (never in
src), and the suite must go red. A mutation whose suite stays green is a claim
that no test actually holds.
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = '/var/folders/s6/15ymxxk93s30yr581vzzzjy40000gn/T/c494/cordis-plugin-tool-deadline-guard'
LIB = os.path.join(ROOT, 'lib/index.js')
BACKUP = os.path.join(ROOT, 'lib/index.js.orig')
NODE = '/Users/argszero/.asdf/installs/nodejs/26.5.0/bin/node'

MUTATIONS = [
    ('applyTo ignored: a declared budget gets a second deadline',
     "if (declared !== undefined && config.applyTo === 'undeclared')",
     "if (false)"),
    ('exempt ignored',
     "if (config.exempt.has(toolName))",
     "if (false)"),
    ('per-tool budget ignored',
     "return config.perTool[toolName] ?? config.defaultTimeoutMs;",
     "return config.defaultTimeoutMs;"),
    ('expiry result never substituted (cooperative)',
     "if (expired) {",
     "if (false) {"),
    ('the tool signal is never fused (no deadline reaches the tool)',
     "exec.signal = AbortSignal.any([upstream, own.signal]);",
     "exec.signal = upstream;"),
    ('the caller signal is not restored for post-execute',
     "            exec.signal = upstream;\n        }",
     "        }"),
    ('our own code replaced by the core policy code',
     "export const TOOL_DEADLINE_EXCEEDED = 'TOOL_DEADLINE_EXCEEDED';",
     "export const TOOL_DEADLINE_EXCEEDED = 'TOOL_TIMEOUT';"),
    ('upstream aborts are reported as this plugin deadline',
     "exec.signal = AbortSignal.any([upstream, own.signal]);",
     "upstream.addEventListener('abort', () => { expired = true; expire(); });\n        exec.signal = AbortSignal.any([upstream, own.signal]);"),
]


def run_suite():
    completed = subprocess.run(
        [NODE, '--test', '--test-timeout=20000', 'test/cordis.spec.mjs'],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    output = completed.stdout + completed.stderr
    passed = [line for line in output.splitlines() if line.startswith('\u2714')]
    failed = [line for line in output.splitlines() if line.startswith('\u2716')]
    return completed.returncode, len(passed), len(failed), output


def main():
    shutil.copy2(LIB, BACKUP)
    original = open(LIB, encoding='utf-8').read()
    results = []
    try:
        for label, needle, replacement in MUTATIONS:
            if needle not in original:
                results.append((label, 'NOT-APPLIED', needle))
                continue
            mutated = original.replace(needle, replacement, 1)
            if mutated == original:
                results.append((label, 'NO-OP', needle))
                continue
            open(LIB, 'w', encoding='utf-8').write(mutated)
            code, passed, failed, output = run_suite()
            verdict = 'RED' if (code != 0 or failed > 0) else 'GREEN (mutation survived!)'
            names = [line.strip()[:88] for line in output.splitlines() if line.startswith('\u2716')]
            results.append((label, verdict, f'pass={passed} fail={failed}', names))
            print(f'--- {label}\n    {verdict} pass={passed} fail={failed}')
            for name in names:
                print(f'      {name}')
            sys.stdout.flush()
    finally:
        open(LIB, 'w', encoding='utf-8').write(original)
        print('\nrestored lib/index.js:', open(LIB, encoding='utf-8').read() == original)
    survivors = [r for r in results if 'GREEN' in str(r[1]) or r[1] in ('NOT-APPLIED', 'NO-OP')]
    print('\nsurvivors/not-applied:', len(survivors))
    for survivor in survivors:
        print(' ', survivor)
    print(json.dumps([r[0:3] for r in results], ensure_ascii=False, indent=1))


main()
