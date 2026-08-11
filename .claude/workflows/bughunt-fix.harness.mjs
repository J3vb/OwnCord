// Offline harness for bughunt-fix.js - mirrors bughunt.harness.mjs: wraps the script body in an
// AsyncFunction with stubbed agent/parallel/pipeline/phase/log/args/budget.
// Run: node .claude/workflows/bughunt-fix.harness.mjs [nameFilter]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function run({ agentStub, args = undefined, budget = undefined }) {
  const src = readFileSync(join(here, 'bughunt-fix.js'), 'utf8')
  const body = src.replace('export const meta', 'const meta')
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentStub(prompt, opts)
  }
  const parallel = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let v = item
        for (const stage of stages) {
          try {
            v = await stage(v, item, i)
          } catch {
            return null
          }
        }
        return v
      }),
    )
  const log = (m) => logs.push(String(m))
  const phase = () => {}
  const budgetImpl = budget || { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body)
  const result = await fn(agent, parallel, pipeline, phase, log, args, budgetImpl)
  return { result, calls, logs }
}

// ---------- fixtures ----------
export const rec = (id, over = {}) => ({
  id,
  title: `bug ${id}`,
  file: 'Client/tauri-client/src/lib/livekitE2EE.ts',
  line: 100,
  severity: 'high',
  why: 'w',
  repro: 'r',
  evidence: 'e',
  status: 'open',
  found: '2026-08-09',
  hunt: 'h',
  lens: 'l',
  fix: null,
  ...over,
})

const scenarios = {}

// F1: clustering groups by file; cluster count equals distinct file count.
scenarios.f1_clusters_by_file = async () => {
  const findings = [
    rec('OC-0001'),
    rec('OC-0002', { line: 800 }),
    rec('OC-0003', { file: 'Server/ws/hub_sweep.go' }),
  ]
  const { result } = await run({
    args: { findings, branch: 'fix/test' },
    agentStub: () => {
      throw new Error('no agent should run in phase 1 with the later phases unimplemented')
    },
  })
  assert.equal(result.branch, 'fix/test')
  assert.equal(result.clusters.length, 2)
  const byFile = Object.fromEntries(result.clusters.map((c) => [c.file, c.ids]))
  assert.deepEqual(byFile['Client/tauri-client/src/lib/livekitE2EE.ts'], ['OC-0001', 'OC-0002'])
  assert.deepEqual(byFile['Server/ws/hub_sweep.go'], ['OC-0003'])
}

// F1b: a backslash/case-only variant of the same path must not split into a second cluster -
// the same disjointness invariant the cross-cluster guard protects, at the grouping step.
scenarios.f1b_clustering_normalizes_backslashes = async () => {
  const findings = [
    rec('OC-0001', { file: 'Server/ws/hub_sweep.go' }),
    rec('OC-0002', { file: 'Server\\ws\\hub_sweep.go' }),
  ]
  const { result } = await run({
    args: { findings },
    agentStub: () => {
      throw new Error('no agent should run in phase 1 with the later phases unimplemented')
    },
  })
  assert.equal(result.clusters.length, 1, 'a backslash variant of the same path must merge into one cluster')
  assert.deepEqual(result.clusters[0].ids.sort(), ['OC-0001', 'OC-0002'])
  assert.equal(result.clusters[0].file, 'Server/ws/hub_sweep.go')
}

// F2: only / maxSeverity / non-open status all exclude, and every exclusion is logged by id.
scenarios.f2_exclusions_are_announced = async () => {
  const findings = [
    rec('OC-0001'),
    rec('OC-0002', { severity: 'low' }),
    rec('OC-0003', { status: 'fixed' }),
    rec('OC-0004'),
  ]
  const { result, logs } = await run({
    args: { findings, only: ['OC-0001', 'OC-0002', 'OC-0003'], maxSeverity: 'medium' },
    agentStub: () => {
      throw new Error('no agent expected')
    },
  })
  const reasons = Object.fromEntries(result.excluded.map((e) => [e.id, e.reason]))
  assert.equal(reasons['OC-0002'], 'below maxSeverity')
  assert.equal(reasons['OC-0003'], 'status is fixed, not open')
  assert.equal(reasons['OC-0004'], 'not in only')
  assert.equal(result.clusters.length, 1)
  assert.deepEqual(result.clusters[0].ids, ['OC-0001'])
  const joined = logs.join('\n')
  for (const id of ['OC-0002', 'OC-0003', 'OC-0004']) {
    assert.match(joined, new RegExp(id), `exclusion of ${id} must be logged, not silent`)
  }
}

// F3: one sonnet/xhigh agent per cluster, and the prompt carries every finding in that file.
scenarios.f3_one_xhigh_agent_per_cluster = async () => {
  const findings = [
    rec('OC-0001'),
    rec('OC-0002', { line: 800 }),
    rec('OC-0003', { file: 'Server/ws/hub_sweep.go' }),
  ]
  const { result, calls } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (!String(opts.label).startsWith('fix:')) throw new Error(`unexpected label ${opts.label}`)
      const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
      return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: `t/${id}.test.ts`, rationale: '' })), touchedPaths: [] }
    },
  })
  const fixCalls = calls.filter((c) => String(c.opts.label).startsWith('fix:'))
  assert.equal(fixCalls.length, 2, 'one agent per file cluster')
  for (const c of fixCalls) {
    assert.equal(c.opts.model, 'sonnet')
    assert.equal(c.opts.effort, 'xhigh')
    assert.equal(c.opts.phase, 'Fix')
  }
  const e2eeCall = fixCalls.find((c) => c.opts.label.includes('livekitE2EE'))
  assert.match(e2eeCall.prompt, /OC-0001/)
  assert.match(e2eeCall.prompt, /OC-0002/)
  assert.ok(!e2eeCall.prompt.includes('OC-0003'), 'a cluster prompt must not leak another file\'s findings')
  assert.match(e2eeCall.prompt, /write a test that fails/i, 'rule 1: test-first')
  assert.match(e2eeCall.prompt, /weakening an assertion/i, 'rule 2: never weaken an assertion')
  assert.match(e2eeCall.prompt, /grep every caller/i, 'rule 3: root cause, grep callers')
  assert.match(e2eeCall.prompt, /touchedPaths/i, 'rule 4: shared-file edits must be listed in touchedPaths')
  assert.match(e2eeCall.prompt, /one change that closes more than one/i, 'rule 5: one change closing several findings')
  assert.match(e2eeCall.prompt, /do not run any git command/i, 'rule 6: no git')
  assert.match(e2eeCall.prompt, /do not invent a fix/i, 'rule 7: declined with a rationale')
  assert.match(e2eeCall.prompt, /mechanical reason/i, 'rule 8: blocked with a rationale')
  assert.equal(result.results.length, 3)
}

// F4: a dead fix agent marks only its own cluster; siblings still report.
scenarios.f4_dead_agent_does_not_poison_siblings = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (opts.label.includes('hub_sweep')) throw new Error('agent died')
      if (String(opts.label).startsWith('prove:'))
        return {
          committed: true,
          sha: 'aaa0000',
          redObserved: true,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nFAIL t.ts > OC-0001 (reverted)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts > OC-0001 (fixed)',
          note: '',
        }
      return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
    },
  })
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r.outcome]))
  assert.equal(byId['OC-0001'], 'fixed')
  assert.equal(byId['OC-0003'], 'blocked')
  const reason = result.results.find((r) => r.id === 'OC-0003').rationale
  assert.match(reason, /agent/i)
}

// F5: a declined finding keeps its rationale and is not treated as fixed.
scenarios.f5_decline_propagates = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: () => ({
      results: [{ id: 'OC-0001', outcome: 'declined', testPath: '', rationale: 'intended behaviour, locked by test X' }],
      touchedPaths: [],
    }),
  })
  assert.equal(result.results[0].outcome, 'declined')
  assert.equal(result.results[0].rationale, 'intended behaviour, locked by test X')
}

// F5b: a foreign id (hallucinated, or copy-pasted from a different cluster) is dropped, not merged,
// and its id is announced in the logs rather than disappearing silently.
scenarios.f5b_foreign_id_is_dropped_and_announced = async () => {
  const findings = [rec('OC-0001')]
  const { result, logs } = await run({
    args: { findings },
    agentStub: () => ({
      results: [
        { id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' },
        { id: 'OC-9999', outcome: 'fixed', testPath: 't2.ts', rationale: '' },
      ],
      touchedPaths: [],
    }),
  })
  assert.deepEqual(result.results.map((r) => r.id), ['OC-0001'])
  assert.match(logs.join('\n'), /OC-9999/, 'the dropped foreign id must be announced in the logs')
}

// F6: prove agents run serially (never overlapping) and only for clusters that produced a fix.
scenarios.f6_prove_is_serial = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  let inFlight = 0
  let maxInFlight = 0
  const { result, calls } = await run({
    args: { findings },
    agentStub: async (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: `t/${id}.ts`, rationale: '' })), touchedPaths: [] }
      }
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return {
        committed: true,
        sha: 'abc1234',
        redObserved: true,
        greenObserved: true,
        redOutput: '$ go test ./ws/ -run TestSweep\nFAIL: reverted source',
        greenOutput: '$ go test ./ws/ -run TestSweep\nPASS: fix restored',
        note: '',
      }
    },
  })
  assert.equal(maxInFlight, 1, 'prove/commit must be serial - git index contention')
  const proveCalls = calls.filter((c) => String(c.opts.label).startsWith('prove:'))
  assert.equal(proveCalls.length, 2)
  for (const c of proveCalls) {
    assert.equal(c.opts.model, 'sonnet')
    assert.equal(c.opts.effort, 'medium')
  }
  assert.equal(result.commits.length, 2)
  assert.deepEqual(result.commits[0], { sha: 'abc1234', file: findings[0].file, ids: ['OC-0001'] })
}

// F7: a vacuous test (revert-proof does not go RED) is NOT committed and its findings go blocked.
scenarios.f7_vacuous_test_is_not_committed = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
      return {
        committed: false,
        sha: '',
        redObserved: false,
        greenObserved: true,
        redOutput: '$ npx vitest run t.ts\nPASS t.ts > OC-0001 (reverted, should have failed)',
        greenOutput: '$ npx vitest run t.ts\nPASS t.ts > OC-0001 (fixed)',
        note: 'test passed with the fix reverted',
      }
    },
  })
  assert.equal(result.commits.length, 0, 'a cluster that failed its revert-proof must not be committed')
  assert.equal(result.results[0].outcome, 'blocked')
  assert.match(result.results[0].rationale, /revert-proof/i)
}

// F7b: RED was observed but the restored fix does not go GREEN - also not committed.
scenarios.f7b_restored_fix_must_be_green = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
      return {
        committed: false,
        sha: '',
        redObserved: true,
        greenObserved: false,
        redOutput: '$ npx vitest run t.ts\nFAIL t.ts > OC-0001 (reverted)',
        greenOutput: '$ npx vitest run t.ts\nFAIL t.ts > OC-0001 (still failing after restore)',
        note: 'still failing after restore',
      }
    },
  })
  assert.equal(result.commits.length, 0)
  assert.equal(result.results[0].outcome, 'blocked')
  assert.match(result.results[0].rationale, /after restoring the fix/i)
}

// F8: a cluster with only declines is never sent to prove, and produces no commit.
scenarios.f8_declined_cluster_skips_prove = async () => {
  const findings = [rec('OC-0001')]
  const { result, calls } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'declined', testPath: '', rationale: 'by design' }], touchedPaths: [] }
      throw new Error('prove must not run for a cluster with no fixes')
    },
  })
  assert.ok(!calls.some((c) => String(c.opts.label).startsWith('prove:')))
  assert.equal(result.commits.length, 0)
  assert.equal(result.results[0].outcome, 'declined')
}

// F9: one failing cluster does not stop its siblings from committing.
scenarios.f9_blocked_cluster_does_not_block_siblings = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: 't.ts', rationale: '' })), touchedPaths: [] }
      }
      if (opts.label.includes('livekitE2EE'))
        return {
          committed: false,
          sha: '',
          redObserved: false,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nPASS t.ts > OC-0001 (reverted, should have failed)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts > OC-0001 (fixed)',
          note: 'vacuous',
        }
      return {
        committed: true,
        sha: 'def5678',
        redObserved: true,
        greenObserved: true,
        redOutput: '$ go test ./ws/ -run TestSweep\nFAIL: reverted source',
        greenOutput: '$ go test ./ws/ -run TestSweep\nPASS: fix restored',
        note: '',
      }
    },
  })
  assert.equal(result.commits.length, 1)
  assert.equal(result.commits[0].sha, 'def5678')
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r.outcome]))
  assert.equal(byId['OC-0001'], 'blocked')
  assert.equal(byId['OC-0003'], 'fixed')
}

// F9b: a mixed cluster (one fixed + one declined) whose prove fails demotes only the fixed
// finding to blocked; the declined finding and its original rationale are left untouched.
scenarios.f9b_declined_survives_a_failed_prove = async () => {
  const declinedRationale = 'intentional: rate limit is a product decision, not a bug'
  const findings = [rec('OC-0001'), rec('OC-0002', { line: 800 })]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        return {
          results: [
            { id: 'OC-0001', outcome: 'fixed', testPath: 't/OC-0001.test.ts', rationale: '' },
            { id: 'OC-0002', outcome: 'declined', testPath: '', rationale: declinedRationale },
          ],
          touchedPaths: [],
        }
      }
      return {
        committed: false,
        sha: '',
        redObserved: false,
        greenObserved: true,
        redOutput: '$ npx vitest run t/OC-0001.test.ts\nPASS (reverted, should have failed)',
        greenOutput: '$ npx vitest run t/OC-0001.test.ts\nPASS (fixed)',
        note: 'test passed with the fix reverted',
      }
    },
  })
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r]))
  assert.equal(byId['OC-0001'].outcome, 'blocked')
  assert.match(byId['OC-0001'].rationale, /revert-proof/i)
  assert.equal(byId['OC-0002'].outcome, 'declined')
  assert.equal(byId['OC-0002'].rationale, declinedRationale)
}

// F10: the gate runs once, and only for the stacks the commits actually touched.
scenarios.f10_gate_targets_touched_stacks = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  let gatePrompt = ''
  const { result, calls } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: 't.ts', rationale: '' })), touchedPaths: [] }
      }
      if (String(opts.label).startsWith('prove:'))
        return {
          committed: true,
          sha: 'aaa1111',
          redObserved: true,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nFAIL t.ts (reverted)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts (fixed)',
          note: '',
        }
      gatePrompt = prompt
      return { passed: true, stacks: ['client', 'server'], output: 'ok' }
    },
  })
  const gateCalls = calls.filter((c) => c.opts.label === 'gate')
  assert.equal(gateCalls.length, 1, 'ci-check runs once, not per fix')
  assert.equal(gateCalls[0].opts.model, 'sonnet')
  assert.equal(gateCalls[0].opts.effort, 'medium')
  assert.match(gatePrompt, /no-experimental-webstorage/, 'client gate command must be spelled out')
  assert.match(gatePrompt, /go build -tags otel/, 'server gate must cover the tagged build variants')
  assert.equal(result.gate.passed, true)
}

// F11: nothing committed means nothing to gate - skip it rather than burn 15 minutes.
scenarios.f11_no_commits_skips_gate = async () => {
  const findings = [rec('OC-0001')]
  const { result, calls } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'declined', testPath: '', rationale: 'by design' }], touchedPaths: [] }
      throw new Error(`no agent expected for label ${opts.label}`)
    },
  })
  assert.ok(!calls.some((c) => c.opts.label === 'gate'))
  assert.equal(result.gate, null)
}

// F12: a red gate does not rewrite history - commits stand, the failure is reported.
scenarios.f12_failing_gate_keeps_commits = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
      if (String(opts.label).startsWith('prove:'))
        return {
          committed: true,
          sha: 'bbb2222',
          redObserved: true,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nFAIL t.ts (reverted)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts (fixed)',
          note: '',
        }
      return { passed: false, stacks: ['client'], output: 'tsc: 3 errors' }
    },
  })
  assert.equal(result.commits.length, 1, 'a failing gate must not revert commits')
  assert.equal(result.results[0].outcome, 'fixed')
  assert.equal(result.gate.passed, false)
  assert.match(result.gate.output, /tsc: 3 errors/)
}

// F12b: a truthy but wrongly-shaped gate response (no boolean `passed`, no `stacks` array) must
// still be treated as a failed gate - falling back to the computed stack list, but keeping the
// agent's own `output` string rather than overwriting it with the generic default message.
scenarios.f12b_malformed_gate_response_is_a_failed_gate = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
      if (String(opts.label).startsWith('prove:'))
        return {
          committed: true,
          sha: 'ccc3333',
          redObserved: true,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nFAIL t.ts (reverted)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts (fixed)',
          note: '',
        }
      // wrongly shaped: no boolean `passed`, no `stacks` array - just a stray `output` string.
      return { ok: true, output: 'ran partway: lint crashed before finishing' }
    },
  })
  assert.equal(result.commits.length, 1, 'a malformed gate response must not lose an already-made commit')
  assert.equal(result.gate.passed, false)
  assert.ok(Array.isArray(result.gate.stacks), 'stacks must fall back to the computed list, not stay undefined')
  assert.deepEqual(result.gate.stacks, ['client'])
  assert.equal(
    result.gate.output,
    'ran partway: lint crashed before finishing',
    "the agent's own output must be preserved, not replaced by the default message",
  )
}

// F12c: the gate agent call itself throws. The .catch(() => null) guard must keep the rejection
// from escaping the workflow - same as Phase 3's prove agent - so commits already made survive
// and the gate is reported as failed rather than the run crashing before its final return.
scenarios.f12c_thrown_gate_agent_does_not_lose_commits = async () => {
  const findings = [rec('OC-0001')]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }], touchedPaths: [] }
      if (String(opts.label).startsWith('prove:'))
        return {
          committed: true,
          sha: 'ddd4444',
          redObserved: true,
          greenObserved: true,
          redOutput: '$ npx vitest run t.ts\nFAIL t.ts (reverted)',
          greenOutput: '$ npx vitest run t.ts\nPASS t.ts (fixed)',
          note: '',
        }
      throw new Error('gate agent died')
    },
  })
  assert.equal(result.commits.length, 1, 'a thrown gate agent must not lose an already-made commit')
  assert.equal(result.commits[0].sha, 'ddd4444')
  assert.equal(result.gate.passed, false)
  assert.equal(result.results[0].outcome, 'fixed', 'a gate failure must not demote an already-committed result')
}

// F13: two clusters whose touchedPaths intersect (a shared root-cause file edited by both
// agents) must both be blocked before Phase 3 - neither may reach prove/commit, and the log
// must name both cluster files and the shared path.
scenarios.f13_intersecting_touched_paths_blocks_both_clusters = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  const { result, logs, calls } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (!String(opts.label).startsWith('fix:')) throw new Error(`only fix agents should run, got ${opts.label}`)
      if (opts.label.includes('livekitE2EE'))
        return {
          results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't/OC-0001.test.ts', rationale: '' }],
          touchedPaths: ['Server/ws/shared_helper.go'],
        }
      return {
        results: [{ id: 'OC-0003', outcome: 'fixed', testPath: 'Server/ws/hub_sweep_test.go', rationale: '' }],
        touchedPaths: ['Server/ws/shared_helper.go'],
      }
    },
  })
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r]))
  assert.equal(byId['OC-0001'].outcome, 'blocked')
  assert.equal(byId['OC-0003'].outcome, 'blocked')
  assert.match(byId['OC-0001'].rationale, /Server\/ws\/shared_helper\.go/)
  assert.match(byId['OC-0003'].rationale, /Server\/ws\/shared_helper\.go/)
  assert.equal(result.commits.length, 0, 'neither cluster may commit once blocked by the overlap guard')
  const joined = logs.join('\n')
  assert.match(joined, /livekitE2EE\.ts/, 'log must name the first cluster file')
  assert.match(joined, /hub_sweep\.go/, 'log must name the second cluster file')
  assert.match(joined, /shared_helper\.go/, 'log must name the shared path')
  assert.ok(!calls.some((c) => String(c.opts.label).startsWith('prove:')), 'blocked clusters must never reach prove')
}

// F14: two clusters with disjoint touchedPaths are unaffected by the guard and both commit.
scenarios.f14_disjoint_touched_paths_both_commit = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        if (opts.label.includes('livekitE2EE'))
          return {
            results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't/OC-0001.test.ts', rationale: '' }],
            touchedPaths: ['Client/tauri-client/src/lib/otherHelper.ts'],
          }
        return {
          results: [{ id: 'OC-0003', outcome: 'fixed', testPath: 'Server/ws/hub_sweep_test.go', rationale: '' }],
          touchedPaths: ['Server/ws/other_helper.go'],
        }
      }
      return {
        committed: true,
        sha: opts.label.includes('livekitE2EE') ? 'e2ee1111' : 'sweep222',
        redObserved: true,
        greenObserved: true,
        redOutput: 'FAIL (reverted)',
        greenOutput: 'PASS (fixed)',
        note: '',
      }
    },
  })
  assert.equal(result.commits.length, 2, 'disjoint touchedPaths must not trip the overlap guard')
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r.outcome]))
  assert.equal(byId['OC-0001'], 'fixed')
  assert.equal(byId['OC-0003'], 'fixed')
}

// F15: the prove prompt for a cluster whose agent reported extra touchedPaths names every one
// of those paths in both the revert (checkout) instruction and the staging (add) instruction -
// not just cluster.file.
scenarios.f15_prove_prompt_names_every_touched_path = async () => {
  const findings = [rec('OC-0001')]
  let provePromptText = ''
  const { result } = await run({
    args: { findings, branch: 'fix/test-touched' },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:'))
        return {
          results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't/OC-0001.test.ts', rationale: '' }],
          touchedPaths: ['Client/tauri-client/src/lib/sharedCrypto.ts'],
        }
      if (String(opts.label).startsWith('prove:')) {
        provePromptText = prompt
        return {
          committed: true,
          sha: 'aaa9999',
          redObserved: true,
          greenObserved: true,
          redOutput: 'FAIL (reverted)',
          greenOutput: 'PASS (fixed)',
          note: '',
        }
      }
      return { passed: true, stacks: ['client'], output: 'ok' }
    },
  })
  assert.equal(result.commits.length, 1)
  const checkoutLine = provePromptText.split('\n').find((l) => l.includes('git checkout HEAD --'))
  assert.ok(checkoutLine, 'prove prompt must contain the checkout instruction')
  assert.match(checkoutLine, /livekitE2EE\.ts/, 'checkout instruction must name the cluster file')
  assert.match(checkoutLine, /sharedCrypto\.ts/, 'checkout instruction must also name the extra touched path')
  const addLine = provePromptText.split('\n').find((l) => l.includes('git add'))
  assert.ok(addLine, 'prove prompt must contain the staging instruction')
  assert.match(addLine, /livekitE2EE\.ts/, 'add instruction must name the cluster file')
  assert.match(addLine, /sharedCrypto\.ts/, 'add instruction must also name the extra touched path')
  assert.match(provePromptText, /rev-parse --abbrev-ref HEAD/, 'prove prompt must guard the current branch')
  assert.match(provePromptText, /fix\/test-touched/, 'branch guard must name the expected branch')
}

// ---------- circuit breaker ----------
// Four findings, one per file, so each becomes its own cluster.
const FOUR_FILES = [
  rec('OC-0001'),
  rec('OC-0002', { file: 'Server/ws/hub_sweep.go' }),
  rec('OC-0003', { file: 'Client/tauri-client/src/lib/livekitSession.ts' }),
  rec('OC-0004', { file: 'Client/tauri-client/src/components/VoiceWidget.ts' }),
]
// A fix stub that reports every id in its prompt as fixed. Ids go through a Set because rec()
// puts each id in both `id` and `title`, so the raw matchAll yields every id twice.
const fixAll = (prompt) => {
  const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
  return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: `t/${id}.ts`, rationale: '' })), touchedPaths: [] }
}
const PROVE_FAIL = {
  committed: false,
  sha: '',
  redObserved: false,
  greenObserved: true,
  redOutput: '$ npx vitest run t.ts\nPASS t.ts (still passing with the fix reverted)',
  greenOutput: '$ npx vitest run t.ts\nPASS t.ts',
  note: 'test did not exercise the bug',
}
const proveOk = (sha) => ({
  committed: true,
  sha,
  redObserved: true,
  greenObserved: true,
  redOutput: '$ npx vitest run t.ts\nFAIL t.ts (reverted)',
  greenOutput: '$ npx vitest run t.ts\nPASS t.ts (fixed)',
  note: '',
})

// F16: three failed revert-proofs out of three attempts trips the breaker, and the fourth cluster
// is never handed to an agent. Load-bearing: this is the one that proves the loop actually stops.
scenarios.f16_breaker_trips_after_majority_prove_failures = async () => {
  const { result, calls, logs } = await run({
    args: { findings: FOUR_FILES },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) return fixAll(prompt)
      if (String(opts.label).startsWith('prove:')) return PROVE_FAIL
      return { passed: true, stacks: [], output: '' }
    },
  })
  const proveCalls = calls.filter((c) => String(c.opts.label).startsWith('prove:'))
  assert.equal(proveCalls.length, 3, 'breaker must stop the loop after minAttempts, not run all four')
  assert.ok(result.breaker, 'breaker report must be present on the result')
  assert.equal(result.breaker.trippedAt, 'prove')
  assert.equal(result.breaker.attempted, 3)
  assert.equal(result.breaker.failed, 3)
  assert.equal(result.commits.length, 0)
  // Every finding ends blocked, but the unreached one must say WHY it was never tried.
  assert.ok(result.results.every((r) => r.outcome === 'blocked'), 'nothing may be left reported as fixed')
  const unreached = result.results.filter((r) => /circuit breaker/i.test(r.rationale))
  assert.equal(unreached.length, 1, 'exactly the one unreached finding carries the breaker rationale')
  assert.match(unreached[0].rationale, /uncommitted/i, 'operator must be told the edits are still in the tree')
  assert.ok(logs.some((l) => /CIRCUIT BREAKER/.test(l)), 'a trip must be announced in the log')
}

// F17: two failures out of two is 100%, but below minAttempts it is noise, not a signal.
scenarios.f17_breaker_holds_below_min_attempts = async () => {
  const { result, calls } = await run({
    args: { findings: FOUR_FILES.slice(0, 2) },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) return fixAll(prompt)
      if (String(opts.label).startsWith('prove:')) return PROVE_FAIL
      return { passed: true, stacks: [], output: '' }
    },
  })
  assert.equal(calls.filter((c) => String(c.opts.label).startsWith('prove:')).length, 2, 'both clusters must be attempted')
  assert.equal(result.breaker, null)
  for (const r of result.results) {
    assert.equal(r.outcome, 'blocked')
    assert.match(r.rationale, /revert-proof failed/, 'rationale must be the real reason, not the breaker')
  }
}

// F18: one failure in four is a bad cluster, not a bad run.
scenarios.f18_breaker_holds_under_threshold = async () => {
  let n = 0
  const { result } = await run({
    args: { findings: FOUR_FILES },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) return fixAll(prompt)
      if (String(opts.label).startsWith('prove:')) return ++n === 1 ? PROVE_FAIL : proveOk(`sha${n}`)
      return { passed: true, stacks: [], output: '' }
    },
  })
  assert.equal(result.breaker, null)
  assert.equal(result.commits.length, 3, 'the three good clusters must still land')
}

// F19: the operator can turn the guard off entirely.
scenarios.f19_breaker_disabled_by_args = async () => {
  const { result, calls } = await run({
    args: { findings: FOUR_FILES, circuitBreaker: false },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) return fixAll(prompt)
      if (String(opts.label).startsWith('prove:')) return PROVE_FAIL
      return { passed: true, stacks: [], output: '' }
    },
  })
  assert.equal(calls.filter((c) => String(c.opts.label).startsWith('prove:')).length, 4, 'all four must be attempted when disabled')
  assert.equal(result.breaker, null)
}

// F20: when the FIX stage is what is failing, proving each of those costs a serial agent per
// cluster and cannot succeed. Load-bearing: this is the cheap early exit.
scenarios.f20_fix_stage_trip_skips_prove_entirely = async () => {
  const { result, calls } = await run({
    args: { findings: FOUR_FILES },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) {
        const ids = [...new Set([...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0]))]
        return {
          results: ids.map((id) =>
            id === 'OC-0001'
              ? { id, outcome: 'fixed', testPath: `t/${id}.ts`, rationale: '' }
              : { id, outcome: 'blocked', testPath: '', rationale: 'could not run the test suite' },
          ),
          touchedPaths: [],
        }
      }
      return { passed: true, stacks: [], output: '' }
    },
  })
  assert.ok(result.breaker, 'breaker report must be present')
  assert.equal(result.breaker.trippedAt, 'fix')
  assert.equal(
    calls.filter((c) => String(c.opts.label).startsWith('prove:')).length,
    0,
    'a fix-stage trip must spend nothing on prove agents',
  )
  assert.equal(result.commits.length, 0)
  assert.equal(result.gate, null, 'no commits means no gate')
}

// F21: a trip does not orphan whatever already landed - the operator needs to know if it is green.
scenarios.f21_trip_still_gates_existing_commits = async () => {
  let n = 0
  const { result, calls } = await run({
    args: { findings: FOUR_FILES },
    agentStub: (prompt, opts) => {
      if (String(opts.label).startsWith('fix:')) return fixAll(prompt)
      if (String(opts.label).startsWith('prove:')) return ++n === 1 ? proveOk('aaa1111') : PROVE_FAIL
      return { passed: true, stacks: ['client'], output: 'all green' }
    },
  })
  assert.ok(result.breaker, 'breaker report must be present')
  assert.equal(result.breaker.trippedAt, 'prove')
  assert.equal(result.commits.length, 1, 'the one proven cluster must survive the trip')
  assert.equal(calls.filter((c) => c.opts.label === 'gate').length, 1, 'the gate must still run over what landed')
  assert.equal(result.gate.passed, true)
}

// ---------- runner ----------
const only = process.argv[2]
for (const [name, fn] of Object.entries(scenarios)) {
  if (only && !name.includes(only)) continue
  try {
    await fn()
  } catch (e) {
    console.error(`FAIL ${name}`)
    throw e
  }
  console.log(`PASS ${name}`)
}
console.log('all scenarios pass')
