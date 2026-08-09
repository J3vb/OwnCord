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
      const ids = [...prompt.matchAll(/OC-\d{4}/g)].map((m) => m[0])
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
  assert.match(e2eeCall.prompt, /do not run any git command/i)
  assert.equal(result.results.length, 3)
}

// F4: a dead fix agent marks only its own cluster; siblings still report.
scenarios.f4_dead_agent_does_not_poison_siblings = async () => {
  const findings = [rec('OC-0001'), rec('OC-0003', { file: 'Server/ws/hub_sweep.go' })]
  const { result } = await run({
    args: { findings },
    agentStub: (prompt, opts) => {
      if (opts.label.includes('hub_sweep')) throw new Error('agent died')
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
