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
// Normalize the grouping key (backslashes -> forward slashes) so a path reported with the
// "wrong" separator does not silently split one real file into two clusters.
const byFile = new Map()
for (const f of selected) {
  const key = String(f.file).replace(/\\/g, '/')
  if (!byFile.has(key)) byFile.set(key, [])
  byFile.get(key).push(f)
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
  required: ['results', 'touchedPaths'],
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
    touchedPaths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'every non-test SOURCE file this agent modified while working this cluster, repo-relative, forward ' +
        'slashes - including cluster.file itself if it was touched, and any shared file outside the cluster ' +
        'the root-cause fix required. Test files belong in testPath (per finding), not here.',
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
    `  4. You may edit a shared file outside your own cluster (${cluster.file}) when that is where the ` +
    `root cause lives. If you do, you MUST list every SOURCE file you modified - including this cluster's ` +
    `own file - in touchedPaths, repo-relative with forward slashes. Test files belong in testPath, not ` +
    `touchedPaths.\n` +
    `  5. Because several findings share this file, look for one change that closes more than one of them ` +
    `before writing separate patches.\n` +
    `  6. DO NOT run any git command. No add, no commit, no stash, no checkout. Other agents are working ` +
    `in this same working tree and git operations collide on the index lock. Leave your changes in the ` +
    `working tree; a later serial phase commits them.\n` +
    `  7. If a finding is wrong, or the correct fix is a deliberate product decision you should not make ` +
    `alone, return outcome "declined" with a rationale. Do not invent a fix you do not believe in.\n` +
    `  8. If you cannot fix it for a mechanical reason (missing fixture, unclear repro), return "blocked" ` +
    `with a rationale.\n\n` +
    `Client tests run from Client/tauri-client with:\n` +
    `  NODE_OPTIONS=--no-experimental-webstorage npx vitest run <testfile>\n` +
    `Server tests run from Server with:\n` +
    `  go test ./<pkg>/ -run <TestName>\n\n` +
    `Return one result per finding id, all ${cluster.ids.length} of them, plus touchedPaths.\n\n` +
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
    }).then((r) => ({
      cluster,
      results: (r && r.results) || [],
      touchedPaths: r && Array.isArray(r.touchedPaths) ? r.touchedPaths.filter((p) => typeof p === 'string' && p) : [],
    })),
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
      touchedPaths: [],
      union: [cluster.file],
    })
    continue
  }
  // A hallucinated id, or one copy-pasted from a different cluster, must not merge in silently.
  const ownIds = new Set(cluster.ids)
  const ownResults = outcome.results.filter((r) => ownIds.has(r.id))
  const foreignResults = outcome.results.filter((r) => !ownIds.has(r.id))
  if (foreignResults.length) {
    log(`fix ${cluster.file}: dropped ${foreignResults.length} result(s) for id(s) not in this cluster - ${foreignResults.map((r) => r.id).join(', ')}`)
  }
  // An agent that skipped a finding entirely leaves it blocked rather than silently dropped.
  const reported = new Set(ownResults.map((r) => r.id))
  const missing = cluster.ids
    .filter((id) => !reported.has(id))
    .map((id) => ({ id, outcome: 'blocked', testPath: '', rationale: 'fix agent returned no result for this finding' }))
  if (missing.length) log(`fix ${cluster.file}: ${missing.length} finding(s) unreported by the agent - blocked`)
  fixed.push({
    cluster,
    results: [...ownResults, ...missing],
    touchedPaths: outcome.touchedPaths,
    union: [...new Set([cluster.file, ...outcome.touchedPaths])],
  })
}

// ---------- phase 2.5: cross-cluster overlap guard ----------
// Rule 4 above lets an agent fix a shared root cause outside its own file - the per-file
// disjointness the whole design leans on (no merge conflicts, a clean revert per cluster) no
// longer holds automatically once that happens. If two clusters' agents both touched the same
// path, Phase 3 cannot safely revert/stage per-cluster: one cluster's revert could silently
// undo the other's real fix (a misattributed VACUOUS TEST) or a real change could never get
// staged at all. Block both clusters rather than guess which one "owns" the shared file.
for (let i = 0; i < fixed.length; i++) {
  for (let j = i + 1; j < fixed.length; j++) {
    const a = fixed[i]
    const b = fixed[j]
    const shared = a.union.filter((p) => b.union.includes(p))
    if (!shared.length) continue
    log(`blocked: ${a.cluster.file} and ${b.cluster.file} both touch ${shared.join(', ')} - both clusters blocked`)
    for (const [entry, other] of [[a, b], [b, a]]) {
      for (const r of entry.results) {
        if (r.outcome === 'fixed') {
          r.outcome = 'blocked'
          r.rationale = `cross-cluster edit: shares ${shared.join(', ')} with ${other.cluster.file} - needs a human`
        }
      }
    }
  }
}

const allResults = fixed.flatMap((f) => f.results)
log(`fix: ${allResults.filter((r) => r.outcome === 'fixed').length} fixed, ` +
  `${allResults.filter((r) => r.outcome === 'declined').length} declined, ` +
  `${allResults.filter((r) => r.outcome === 'blocked').length} blocked`)

// ---------- phase 3: prove + commit ----------
phase('Prove')

const PROVE_RESULT = {
  type: 'object',
  required: ['committed', 'sha', 'redObserved', 'greenObserved', 'redOutput', 'greenOutput', 'note'],
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string', description: 'short sha of the commit, empty when not committed' },
    redObserved: { type: 'boolean', description: 'did the tests FAIL with the source reverted' },
    greenObserved: { type: 'boolean', description: 'did the tests PASS with the fix restored' },
    redOutput: {
      type: 'string',
      description:
        'the ACTUAL output of the test run performed with the source reverted (step 4), including the ' +
        'command that was run. This run must FAIL. Paste the real captured output verbatim - not a ' +
        'summary, not a paraphrase.',
    },
    greenOutput: {
      type: 'string',
      description:
        'the ACTUAL output of the test run performed after the fix was restored (step 6), including the ' +
        'command that was run. This run must PASS. Paste the real captured output verbatim - not a ' +
        'summary, not a paraphrase.',
    },
    note: { type: 'string', description: 'why it was not committed, empty on success' },
  },
}

function provePrompt(cluster, fixedIds, testPaths, sourcePaths) {
  return (
    `You are proving and committing ONE cluster of fixes in the OwnCord repo ` +
    `(D:/Local-Lab/Repos/OwnCord), on branch ${BRANCH}.\n\n` +
    `Source file(s): ${sourcePaths.join(', ')}\n` +
    `Findings fixed here: ${fixedIds.join(', ')}\n` +
    `Test files written: ${testPaths.join(', ') || '(none reported)'}\n\n` +
    `You are running SERIALLY. No other agent is touching git right now, so you may use git freely.\n\n` +
    `Do exactly this, in order:\n` +
    `  1. Run: git rev-parse --abbrev-ref HEAD\n` +
    `     It MUST print exactly "${BRANCH}". If it does not, DO NOT touch git any further: set ` +
    `committed=false, explain in note which branch you actually found, and STOP. Committing to the wrong ` +
    `branch (e.g. main, because the operator forgot to create/checkout ${BRANCH} first) is not recoverable ` +
    `by this agent.\n` +
    `  2. Copy the current (fixed) contents of ALL source file(s) listed above to a scratch location ` +
    `outside the repo.\n` +
    `  3. Run: git checkout HEAD -- ${sourcePaths.join(' ')}\n` +
    `     Revert every source path listed above, and nothing else. Do NOT revert or delete the test ` +
    `files - a brand-new test file is untracked and this leaves it alone, and a new case in an existing ` +
    `test file is a modification to a path you did not name, so it survives too. Either way the new ` +
    `assertions are present while the fix is gone.\n` +
    `  4. Run the tests listed above. They MUST fail. Set redObserved accordingly. Capture the ACTUAL ` +
    `output of this run, including the command you ran, and return it verbatim in redOutput - not a ` +
    `summary, not a paraphrase.\n` +
    `     If they PASS, the tests do not pin the bug - they are vacuous. Restore the fixed source from ` +
    `scratch, set committed=false, explain in note, and STOP. Do not commit. Do not try to repair the ` +
    `test yourself.\n` +
    `  5. Restore the fixed source file(s) from your scratch copy.\n` +
    `  6. Run the tests again. They MUST pass. Set greenObserved accordingly. Capture the ACTUAL output ` +
    `of this run, including the command you ran, and return it verbatim in greenOutput - not a summary, ` +
    `not a paraphrase. If they do not pass, set committed=false, explain in note, and STOP.\n` +
    `  7. Stage ALL source file(s) listed above (git add ${sourcePaths.join(' ')}) AND the test files, ` +
    `then commit with subject:\n` +
    `     fix(<area>): ${fixedIds.length} defect(s) (${fixedIds.join(', ')})\n` +
    `     Use a conventional-commit area matching the file (voice, ws, client, identity...). Do not add a ` +
    `Co-Authored-By trailer.\n` +
    `  8. Return the short sha.\n\n` +
    `Client tests run from Client/tauri-client with:\n` +
    `  NODE_OPTIONS=--no-experimental-webstorage npx vitest run <testfile>\n` +
    `Server tests run from Server with:\n` +
    `  go test ./<pkg>/ -run <TestName>`
  )
}

const commits = []
// Serial on purpose: parallel git commands collide on .git/index.lock.
for (const { cluster, results, union } of fixed) {
  const fixedHere = results.filter((r) => r.outcome === 'fixed')
  if (!fixedHere.length) {
    log(`prove ${cluster.file}: no fixes to prove - skipped`)
    continue
  }
  const ids = fixedHere.map((r) => r.id)
  const testPaths = [...new Set(fixedHere.map((r) => r.testPath).filter(Boolean))]
  // A dead/thrown prove agent must not take down the sibling clusters still waiting in this
  // serial loop - same "one blocked cluster does not poison the rest" rule Phase 2 gets from
  // parallel()'s catch. Fold it into a null result so the ok/why logic below handles it uniformly.
  const p = await agent(provePrompt(cluster, ids, testPaths, union), {
    label: `prove:${cluster.file}`,
    phase: 'Prove',
    model: 'sonnet',
    effort: 'medium',
    schema: PROVE_RESULT,
  }).catch(() => null)

  const ok = p && p.committed && p.redObserved && p.greenObserved && p.sha
  if (!ok) {
    const why = !p
      ? 'prove agent failed'
      : !p.redObserved
        ? `revert-proof failed: tests still passed with the fix reverted (${p.note || 'no note'})`
        : !p.greenObserved
          ? `tests did not pass after restoring the fix (${p.note || 'no note'})`
          : `not committed (${p.note || 'no note'})`
    log(`prove ${cluster.file}: ${why} - ${ids.length} finding(s) blocked`)
    for (const r of results) {
      if (r.outcome === 'fixed') {
        r.outcome = 'blocked'
        r.rationale = why
      }
    }
    continue
  }
  commits.push({ sha: p.sha, file: cluster.file, ids })
  log(`prove ${cluster.file}: committed ${p.sha} (${ids.join(', ')})`)
}

// ---------- phase 4: gate ----------
const GATE_RESULT = {
  type: 'object',
  required: ['passed', 'stacks', 'output'],
  properties: {
    passed: { type: 'boolean' },
    stacks: { type: 'array', items: { type: 'string' } },
    output: { type: 'string', description: 'the failing command and its output, or a short ok summary' },
  },
}

function stacksFor(files) {
  const s = new Set()
  for (const f of files) {
    if (f.startsWith('Server/')) s.add('server')
    else if (f.startsWith('Client/tauri-client/src-tauri/')) s.add('rust')
    else if (f.startsWith('Client/')) s.add('client')
  }
  return [...s]
}

const GATE_COMMANDS = {
  client:
    `From Client/tauri-client:\n` +
    `  NODE_OPTIONS=--no-experimental-webstorage npm test\n` +
    `  npm run typecheck\n` +
    `  npm run lint\n` +
    `  npm run format:check`,
  server:
    `From Server:\n` +
    `  go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./...\n` +
    `  go vet ./...\n` +
    `  go test -race ./...\n` +
    `  go test -tags deadlock -count=1 ./ws/\n` +
    `  golangci-lint run\n` +
    `  make sqlc-verify protocol-verify   # generated output must not be stale. If make is not on PATH, ` +
    `run the equivalent commands directly instead: ` +
    `"sqlc generate && git diff --exit-code db/dbgen" and ` +
    `"go run ./scripts/genprotocol && git diff --exit-code ws/message_types.go ../Client/tauri-client/src/lib/protocolTypes.ts" ` +
    `- a non-empty diff in either means generated code is stale and the gate fails`,
  rust:
    `From Client/tauri-client/src-tauri:\n` +
    `  cargo test\n` +
    `  cargo clippy --all-targets -- -D warnings`,
}

let gate = null
if (commits.length) {
  phase('Gate')
  const stacks = stacksFor(commits.map((c) => c.file))
  gate = await agent(
    `Run the OwnCord CI gates locally for the stacks touched by this fix run, on branch ${BRANCH}.\n\n` +
      `This runs ONCE for the whole run - a full gate per fix would take longer than the fixing did.\n\n` +
      `Touched stacks: ${stacks.join(', ')}\n\n` +
      stacks.map((s) => GATE_COMMANDS[s]).join('\n\n') +
      `\n\nRun every command for every touched stack. Report passed=false if ANY of them fails, and put ` +
      `the failing command plus the relevant output in "output". Do NOT fix anything, do NOT amend or ` +
      `revert any commit, and do NOT push. Reporting the failure accurately is the whole job.\n\n` +
      `Known false alarm: a windows -race failure inside ws whose stack mentions runtime.scanstack or ` +
      `runtime.(*unwinder).next is a Go 1.26.5 runtime GC fault, not a real failure - rerun that package ` +
      `once before reporting it.`,
    { label: 'gate', phase: 'Gate', model: 'sonnet', effort: 'medium', schema: GATE_RESULT },
  ).catch(() => null)
  // A malformed/missing report (dead agent, or a schema the caller didn't honor) is treated as a
  // failed gate, same as the null-check pattern in phases 2 and 3 - never crash on shape here.
  if (!gate || typeof gate.passed !== 'boolean' || !Array.isArray(gate.stacks))
    gate = { passed: false, stacks, output: (gate && gate.output) || 'gate agent failed to report' }
  log(`gate: ${gate.passed ? 'PASS' : 'FAIL'} (${gate.stacks.join(', ')})`)
} else {
  log('gate: nothing committed - skipped')
}

return { branch: BRANCH, clusters: publicClusters, excluded, commits, results: allResults, gate }
