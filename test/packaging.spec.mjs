/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, and must not declare packages it never imports.
 *
 * Both directions have bitten these plugins before (the same guard runs in
 * `cordis-plugin-session-trigger`, `search-budget` and `credential-rotate`):
 *
 * - A value import left in `peerDependencies`-only (or, worse,
 *   `devDependencies`-only) resolves fine on the publishing machine — the
 *   workspace is right there — and fails for a consumer with
 *   `ERR_MODULE_NOT_FOUND`. `npm i <name>` in an empty directory is the only
 *   shape that catches it, and it only catches it after the release.
 * - A dependency kept after the import is gone is invisible until someone audits
 *   the tarball, and it silently widens the install closure.
 *
 * So the guard asserts an equivalence, not a one-way rule: the set of bare
 * specifiers reached by `src/**\/*.ts` and `lib/**\/*.js` equals the set of
 * runtime-declared packages (`dependencies` ∪ `peerDependencies`). A missing
 * declaration and a stale declaration both fail.
 *
 * The behaviour suite here imports `@deepseek-ai/dsh-system-prompt`, which is
 * deliberately test-only: it is what a real mount has, and nothing in `lib/`
 * reaches it. That is why the guard scans `src/**\/*.ts` **and** `lib/**\/*.js`
 * but asserts against the runtime closure only.
 *
 * `node:test` walks the same directory as the behaviour suite, so `npm test`
 * cannot pass without it — and the build runs first, so `lib/` is present.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/**
 * Bare specifiers reached by `import`/`export from`, dynamic `import()`, and
 * `require()` in one source text.
 *
 * Relative and absolute targets are not packages; `node:` builtins are not
 * installable. Both are dropped here rather than filtered per call site.
 */
function bareSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers].filter((specifier) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) return false
    if (specifier.startsWith('node:')) return false
    return true
  })
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])
const devDeclared = new Set(Object.keys(manifest.devDependencies ?? {}))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

test('the guard has something to guard', () => {
  // A walk that silently finds nothing would make both assertions below vacuous.
  assert.ok(sourceFiles.some((file) => file.includes(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some((file) => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 3, `expected several bare imports, saw ${imported.size}`)
})

test('every bare import in the published artifact is a runtime dependency', () => {
  const undeclared = [...imported].filter((name) => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `these packages are imported by the shipped code but declared only in devDependencies (or nowhere): ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter((name) => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('test-only packages stay out of the runtime closure', () => {
  const leaked = [...devDeclared].filter((name) => runtimeDeclared.has(name))
  // cordis and dsh-llm are deliberately both: peers for consumers, dev deps so
  // this repository can build and test itself.
  const allowed = new Set(Object.keys(manifest.peerDependencies ?? {}))
  assert.deepEqual(
    leaked.filter((name) => !allowed.has(name)),
    [],
    `a devDependency also declared as a runtime dependency: ${leaked.join(', ')}`,
  )
})

test('the shipped file list carries the manifest the harness reads', () => {
  // `dsh.bundle.patch` is how a profile finds the mount entry; shipping the
  // package without it makes the published artifact unusable.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch file must be in `files`')
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'and must exist')
})

test('the peer ranges are the audited unions, not a single line', () => {
  // A prerelease peer range is read two ways: npm excludes a prerelease unless a
  // comparator in the range names the same version tuple, while pnpm passes
  // includePrerelease and admits more for the same string. A range that only
  // names the line it was written on therefore installs under one package
  // manager and ERESOLVEs under the other, with the divergence made of exactly
  // the releases the reporters run on.
  //
  // The two strings below are the audit's result: one explicit segment per line,
  // so both readings admit the same set. `probe-peer-range.mjs` is the audit —
  // re-run it against the registry before changing either string, and never let
  // one of these drift back to a single `>=a <b` segment covering several lines.
  assert.equal(
    manifest.peerDependencies['@deepseek-ai/dsh-tools'],
    '>=0.1.2-rc.1 <0.1.3 || >=0.1.3-alpha.2 <0.1.4 || >=0.1.5-alpha.1 <0.1.6'
      + ' || >=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.1'
      + ' || >=0.2.1-alpha.1 <0.2.2',
  )
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '>=4.0.2 <5 || >=4.0.5-alpha.1 <5')
  // The next release line is never admitted by a segment that stops short of
  // naming it: that is what makes this a claim about code that has been run.
  assert.match(manifest.peerDependencies['@deepseek-ai/dsh-tools'], />=0\.2\.1-alpha\.1 <0\.2\.2$/)
})

test('the build output is committed, so a git install ships an entry point', () => {
  // `main` and `exports` point into `lib/`, and a git dependency is packed from
  // the repository rather than from a build machine. If `lib/` is ignored and
  // absent from the tree, `dsh plugin add github:…#<tag>` exits 0 and installs a
  // package with no entry point — installation succeeds and mounting cannot.
  // The npm tarball never shows this, because `prepublishOnly` builds it first,
  // which is what let the git channel stay broken while the package looked fine.
  //
  // So both halves are asserted: the artifact exists, and the repository is what
  // carries it. A packed tarball has no `.git` and keeps no repository, so the
  // git half is skipped there — the artifact half still has to hold.
  assert.ok(existsSync(join(ROOT, 'lib', 'index.js')), 'lib/index.js must exist — `npm test` builds before this runs')
  if (!existsSync(join(ROOT, '.git'))) return

  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  assert.notEqual(
    git(['check-ignore', '-q', 'lib/index.js']).status,
    0,
    'lib/index.js is git-ignored: a git install of this repository would ship no entry point',
  )
  assert.equal(
    git(['ls-files', '--error-unmatch', 'lib/index.js']).status,
    0,
    'lib/index.js must be committed, not merely built on the machine that ran the suite',
  )
})
