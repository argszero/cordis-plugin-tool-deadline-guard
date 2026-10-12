/**
 * Peer-range audit — the admitted set of a range under the two readings a real
 * consumer uses. `npm` excludes prereleases unless a comparator names the same
 * version tuple (includePrerelease:false); pnpm sets includePrerelease:true and
 * therefore admits more for the same range. A range whose two sets differ
 * installs in one package manager and ERESOLVEs in the other.
 */
import semver from '/Users/argszero/.asdf/installs/nodejs/26.5.0/lib/node_modules/npm/node_modules/semver/index.js'

const DSH_TOOLS = ["0.0.1-rc.1","0.0.1-rc.2","0.0.1-rc.3","0.0.1-rc.5","0.1.0-rc.2","0.1.0-rc.3","0.1.0-rc.6","0.1.0-rc.7","0.1.0-rc.8","0.1.1-rc.1","0.1.1-rc.2","0.1.2-alpha.2","0.1.2-alpha.3","0.1.2-alpha.4","0.1.2-alpha.5","0.1.2-rc.1","0.1.3-alpha.2","0.1.5-alpha.1","0.1.5-alpha.2","0.1.5-rc.1","0.1.5-rc.2","0.1.5-rc.3","0.1.6-alpha.1","0.1.6-alpha.2","0.1.7-alpha.1","0.1.7-alpha.2","0.1.7-rc.1","0.1.7-rc.2","0.2.0-rc.1","0.2.0-rc.2","0.2.1-alpha.1","0.2.1-alpha.2"]
const CORDIS = ["4.0.1-rc.1","4.0.1-rc.4","4.0.1","4.0.2","4.0.3","4.0.4","4.0.5-alpha.1"]

function audit(label, range, versions) {
  const npmAdmitted = versions.filter(v => semver.satisfies(v, range, { includePrerelease: false }))
  const pnpmAdmitted = versions.filter(v => semver.satisfies(v, range, { includePrerelease: true }))
  const onlyNpm = npmAdmitted.filter(v => !pnpmAdmitted.includes(v))
  const onlyPnpm = pnpmAdmitted.filter(v => !npmAdmitted.includes(v))
  console.log(`--- ${label} ---`)
  console.log(`  range: ${range}`)
  console.log(`  npm  (includePrerelease:false): ${npmAdmitted.length}/${versions.length} ${JSON.stringify(npmAdmitted)}`)
  console.log(`  pnpm (includePrerelease:true) : ${pnpmAdmitted.length}/${versions.length} ${JSON.stringify(pnpmAdmitted)}`)
  console.log(`  divergence: npm-only=${JSON.stringify(onlyNpm)} pnpm-only=${JSON.stringify(onlyPnpm)}`)
  return { npmAdmitted, pnpmAdmitted, onlyNpm, onlyPnpm }
}

const CURRENT = '>=0.1.2-rc.1 <0.2.0 || >=0.1.3-alpha.2 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-alpha.1 <0.2.0'
audit('dsh-tools CURRENT (0.1.0 package.json)', CURRENT, DSH_TOOLS)

const PROPOSED = '>=0.1.2-rc.1 <0.1.3 || >=0.1.3-alpha.2 <0.1.4 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.1 || >=0.2.1-alpha.1 <0.2.2'
audit('dsh-tools PROPOSED (0.2.0 package.json)', PROPOSED, DSH_TOOLS)

audit('cordis CURRENT ^4.0.2', '^4.0.2', CORDIS)
audit('cordis PROPOSED >=4.0.2 <5 || >=4.0.5-alpha.1 <5', '>=4.0.2 <5 || >=4.0.5-alpha.1 <5', CORDIS)
