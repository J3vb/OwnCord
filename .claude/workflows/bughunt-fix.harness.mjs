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
      return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: `t/${id}.test.ts`, rationale: '' })) }
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
  assert.match(e2eeCall.prompt, /one change that closes more than one/i, 'rule 4: one change closing several findings')
  assert.match(e2eeCall.prompt, /do not run any git command/i, 'rule 5: no git')
  assert.match(e2eeCall.prompt, /do not invent a fix/i, 'rule 6: declined with a rationale')
  assert.match(e2eeCall.prompt, /mechanical reason/i, 'rule 7: blocked with a rationale')
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
      return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: `t/${id}.ts`, rationale: '' })) }
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
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
        return { results: [{ id: 'OC-0001', outcome: 'declined', testPath: '', rationale: 'by design' }] }
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
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: 't.ts', rationale: '' })) }
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
        return { results: ids.map((id) => ({ id, outcome: 'fixed', testPath: 't.ts', rationale: '' })) }
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
        return { results: [{ id: 'OC-0001', outcome: 'declined', testPath: '', rationale: 'by design' }] }
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
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
        return { results: [{ id: 'OC-0001', outcome: 'fixed', testPath: 't.ts', rationale: '' }] }
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
