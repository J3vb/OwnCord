export const meta = {
  name: 'bughunt-fix',
  description: 'Fix open ledger findings test-first: per-file agents, mechanical revert-proof, serial commits, one ci-check gate',
  whenToUse: 'After a bughunt run has been written to the findings ledger and a human has skimmed it. Consumes open findings, produces commits on a branch. Never opens a PR.',
  phases: [
    { title: 'Plan', detail: 'cluster open findings by file' },
    { title: 'Fix', detail: 'sonnet/xhigh: one agent per file, test-first, no git' },
    { title: 'Prove', detail: 'sonnet: serial revert-proof then commit per cluster' },
    { title: 'Gate', detail: 'sonnet: ci-check for the touched stacks, once' },
  ],
}

// args has been observed arriving JSON-stringified; coerce it the same way bughunt.js does.
const ARGS = (() => {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) || {}
    } catch {
      return {}
    }
  }
  return args || {}
})()

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const BRANCH = ARGS.branch || 'fix/bughunt'
const ONLY = Array.isArray(ARGS.only) && ARGS.only.length ? new Set(ARGS.only) : null
const MAX_SEVERITY = ARGS.maxSeverity || 'low'
const ALL = Array.isArray(ARGS.findings) ? ARGS.findings : []

// ---------- phase 1: plan ----------
phase('Plan')

const excluded = []
const selected = []
for (const f of ALL) {
  if (f.status && f.status !== 'open') {
    excluded.push({ id: f.id, reason: `status is ${f.status}, not open` })
  } else if (ONLY && !ONLY.has(f.id)) {
    excluded.push({ id: f.id, reason: 'not in only' })
  } else if ((SEV_RANK[f.severity] ?? 3) > (SEV_RANK[MAX_SEVERITY] ?? 3)) {
    excluded.push({ id: f.id, reason: 'below maxSeverity' })
  } else {
    selected.push(f)
  }
}

// Group by file. One agent per file is what removes merge conflicts (clusters are disjoint)
// and what makes a root-cause fix possible - the agent sees every defect in the file at once.
const byFile = new Map()
for (const f of selected) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}
const clusters = [...byFile.entries()].map(([file, findings]) => ({
  file,
  ids: findings.map((f) => f.id),
  findings,
}))

log(`plan: ${selected.length} finding(s) in ${clusters.length} file cluster(s) on ${BRANCH}`)
for (const c of clusters) log(`  ${c.file}: ${c.ids.join(', ')}`)
// Announce every exclusion by id. Silent truncation reads as "covered everything" when it did not.
for (const e of excluded) log(`  excluded ${e.id}: ${e.reason}`)

const publicClusters = clusters.map((c) => ({ file: c.file, ids: c.ids }))

// ---------- schemas ----------
const FIX_RESULTS = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'outcome', 'testPath', 'rationale'],
        properties: {
          id: { type: 'string', description: 'the ledger id, e.g. OC-0042' },
          outcome: { type: 'string', enum: ['fixed', 'declined', 'blocked'] },
          testPath: { type: 'string', description: 'repo-relative path of the test that pins this finding; empty if not fixed' },
          rationale: { type: 'string', description: 'required for declined and blocked; empty for fixed' },
        },
      },
    },
  },
}

// ---------- phase 2: fix ----------
phase('Fix')

function fixPrompt(cluster) {
  return (
    `You are fixing confirmed bugs in ONE file of the OwnCord repo (D:/Local-Lab/Repos/OwnCord).\n` +
    `Your file: ${cluster.file}\n\n` +
    `You own this file for this run. No other agent will touch it, so fix ALL of the findings below ` +
    `together rather than one at a time.\n\n` +
    `RULES\n` +
    `  1. Test first. For each finding, write a test that FAILS against the current code before you ` +
    `change anything, and run it to watch it fail. A test that passes before the fix does not pin the ` +
    `bug and will be rejected mechanically later.\n` +
    `  2. Never make a failing test pass by weakening an assertion. The existing suite is green and must ` +
    `stay green on its current assertions.\n` +
    `  3. Fix the ROOT CAUSE. Grep every caller of the function you are about to change. One guard in a ` +
    `shared function beats a guard in every caller, and patching only the path a finding names leaves its ` +
    `siblings broken.\n` +
    `  4. Because several findings share this file, look for one change that closes more than one of them ` +
    `before writing separate patches.\n` +
    `  5. DO NOT run any git command. No add, no commit, no stash, no checkout. Other agents are working ` +
    `in this same working tree and git operations collide on the index lock. Leave your changes in the ` +
    `working tree; a later serial phase commits them.\n` +
    `  6. If a finding is wrong, or the correct fix is a deliberate product decision you should not make ` +
    `alone, return outcome "declined" with a rationale. Do not invent a fix you do not believe in.\n` +
    `  7. If you cannot fix it for a mechanical reason (missing fixture, unclear repro), return "blocked" ` +
    `with a rationale.\n\n` +
    `Client tests run from Client/tauri-client with:\n` +
    `  NODE_OPTIONS=--no-experimental-webstorage npx vitest run <testfile>\n` +
    `Server tests run from Server with:\n` +
    `  go test ./<pkg>/ -run <TestName>\n\n` +
    `Return one result per finding id, all ${cluster.ids.length} of them.\n\n` +
    `--- FINDINGS IN ${cluster.file} ---\n${JSON.stringify(cluster.findings, null, 2)}`
  )
}

const fixOutcomes = await parallel(
  clusters.map((cluster) => () =>
    agent(fixPrompt(cluster), {
      label: `fix:${cluster.file}`,
      phase: 'Fix',
      model: 'sonnet',
      effort: 'xhigh',
      schema: FIX_RESULTS,
    }).then((r) => ({ cluster, results: (r && r.results) || [] })),
  ),
)

// A null slot means the agent died or threw. Its findings are blocked, its siblings are unaffected.
const fixed = []
for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i]
  const outcome = fixOutcomes[i]
  if (!outcome) {
    log(`fix ${cluster.file}: agent failed - ${cluster.ids.length} finding(s) blocked`)
    fixed.push({
      cluster,
      results: cluster.ids.map((id) => ({ id, outcome: 'blocked', testPath: '', rationale: 'fix agent failed or returned nothing' })),
    })
    continue
  }
  // An agent that skipped a finding entirely leaves it blocked rather than silently dropped.
  const reported = new Set(outcome.results.map((r) => r.id))
  const missing = cluster.ids
    .filter((id) => !reported.has(id))
    .map((id) => ({ id, outcome: 'blocked', testPath: '', rationale: 'fix agent returned no result for this finding' }))
  if (missing.length) log(`fix ${cluster.file}: ${missing.length} finding(s) unreported by the agent - blocked`)
  fixed.push({ cluster, results: [...outcome.results, ...missing] })
}

const allResults = fixed.flatMap((f) => f.results)
log(`fix: ${allResults.filter((r) => r.outcome === 'fixed').length} fixed, ` +
  `${allResults.filter((r) => r.outcome === 'declined').length} declined, ` +
  `${allResults.filter((r) => r.outcome === 'blocked').length} blocked`)

return { branch: BRANCH, clusters: publicClusters, excluded, commits: [], results: allResults, gate: null }
