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

return { branch: BRANCH, clusters: publicClusters, excluded, commits: [], results: [], gate: null }
