// Offline harness for bughunt.js - mimics the workflow runtime: wraps the script
// body in an AsyncFunction with stubbed agent/parallel/pipeline/phase/log/args/budget.
// Run: node .claude/workflows/bughunt.harness.mjs [nameFilter]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function run({ agentStub, args = undefined, budget = undefined }) {
  const src = readFileSync(join(here, 'bughunt.js'), 'utf8')
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

// ---------- stub kit (used from Task 2 onward; harmless now) ----------
export function makeStub({ hunt, verify, recon = defaultRecon }) {
  return (prompt, opts) => {
    const label = opts.label || ''
    if (label.startsWith('recon:')) return recon(label)
    let m = /^r(\d+):hunt:([a-z0-9-]+):opus$/.exec(label)
    if (m) return hunt(Number(m[1]), m[2], 'opus', prompt)
    m = /^r(\d+):verify:([a-z0-9-]+?)(:retry)?$/.exec(label)
    if (m) {
      const candidates = JSON.parse(prompt.split('--- CANDIDATES ---')[1])
      return verify(Number(m[1]), m[2], candidates, Boolean(m[3]), prompt)
    }
    throw new Error(`unexpected agent label: ${label}`)
  }
}
export function defaultRecon() {
  return 'Server/ws/hub.go 12\nServer/api/user.go 9\nClient/tauri-client/src/lib/dispatcher.ts 8'
}
export const none = { findings: [] }
export const finding = (n, over = {}) => ({
  title: `distinct bug alpha${n} omega${n}`,
  file: 'Server/ws/hub.go',
  line: 100 + n * 40,
  severity: 'high',
  why: 'w',
  repro: 'r',
  evidence: 'e',
  ...over,
})
export const graphRows = (n) =>
  Array.from({ length: n }, (_, i) => ({ file: `Server/gen/g${i}.go`, score: 1 - i / (n + 1), degree: 10, cited: 5 }))
export const inventoryRows = (n, over = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    file: `Server/gen/g${i}.go`, degree: 10, cited: 5, score: 1 - i / (n + 1),
    examined: false, risky: false, ...over(i),
  }))
export const confirmAll = (cands) => ({
  verdicts: cands.map((c) => ({
    title: c.title, file: c.file, line: c.line,
    refuted: false, reason: 'confirmed', confidence: 'high',
    severity: c.severity || 'high', fix: 'fix',
  })),
})
export const refuteAll = (cands) => ({
  verdicts: cands.map((c) => ({
    title: c.title, file: c.file, line: c.line,
    refuted: true, reason: 'refuted', confidence: 'high',
    severity: c.severity || 'high',
  })),
})

// ---------- scenarios ----------
const scenarios = {}

// S1: happy convergence - one bug in round 1, rounds 2-3 dry -> converged.
scenarios.s1_convergence = async () => {
  const { result, calls, logs } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  for (const k of ['converged', 'stoppedOnBudget', 'rounds', 'confirmed', 'unverified', 'report'])
    assert.ok(k in result, `missing key ${k}`)
  assert.equal(result.converged, true)
  assert.equal(result.rounds.length, 3)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [0, 1, 2])
  assert.deepEqual(result.rounds.map((r) => r.family), ['surfaces', 'bug-classes', 'flows'])
  assert.equal(result.confirmed.length, 1)
  assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('r4:')), 'no round 4 after convergence')
  assert.ok(!calls.some((c) => c.opts.label === 'report'), 'the report is built in-script')
  assert.match(result.report, /CONVERGED after 3 round\(s\)/)
  assert.match(result.report, /### high - distinct bug alpha1 omega1/)
  assert.match(result.report, /\| 1 \| surfaces \|/)
  assert.ok(logs.some((l) => /budget=NONE - cost ceiling disarmed/.test(l)), 'a directive-less run must announce the dead ceiling')
}

// S2: near-duplicate findings from a single finder collapse - one candidate, one verify call.
scenarios.s2_finder_dedupe = async () => {
  const verifyBatches = []
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key) =>
        round === 1 && key === 'ws-hub'
          ? { findings: [finding(1, { line: 100 }), finding(1, { line: 105, title: 'distinct bug alpha1 omega1 variant' })] }
          : none,
      verify: (round, key, cands) => {
        verifyBatches.push(cands)
        return confirmAll(cands)
      },
    }),
  })
  assert.equal(verifyBatches.length, 1)
  assert.equal(verifyBatches[0].length, 1)
  assert.equal(result.confirmed.length, 1)
  const hunts = calls.filter((c) => /^r1:hunt:ws-hub:/.test(c.opts.label || ''))
  assert.equal(hunts.length, 1, 'exactly one finder call per lens - the sonnet slot is gone')
  assert.match(hunts[0].opts.label, /:opus$/, 'the label keeps the :opus suffix the harness parses')
}

// S3: refuted findings stay dead - re-reported next round, never re-verified; refutes count toward dry.
scenarios.s3_refuted_permanence = async () => {
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round === 1 && key === 'ws-hub' && model === 'opus') return { findings: [finding(2)] }
        if (round === 2 && key === 'state-desync' && model === 'opus') return { findings: [finding(2)] }
        return none
      },
      verify: (round, key, cands) => refuteAll(cands),
    }),
  })
  const verifyRounds = calls
    .map((c) => /^r(\d+):verify:/.exec(c.opts.label || ''))
    .filter(Boolean)
    .map((m) => Number(m[1]))
  assert.deepEqual(verifyRounds, [1], 'refuted candidate must not be re-verified in round 2')
  assert.equal(result.rounds[0].refuted, 1)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.rounds.length, 2) // refute-only r1 is dry -> converged after r2
  assert.equal(result.converged, true)
  assert.ok(!calls.some((c) => c.opts.label === 'report'), 'zero confirmed -> code-built report')
  assert.match(result.report, /Converged/i)
}

// S4: backstop - fresh confirmed bug every round with maxRounds=3 -> stops, NOT converged.
scenarios.s4_backstop = async () => {
  const firstLens = { 1: 'ws-hub', 2: 'concurrency', 3: 'flow-reconnect' }
  const { result } = await run({
    args: { maxRounds: 3 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        model === 'opus' && key === firstLens[round]
          ? { findings: [finding(round, { file: `Server/ws/f${round}.go` })] }
          : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.equal(result.rounds.length, 3)
  assert.equal(result.converged, false)
  assert.equal(result.stoppedOnBudget, false)
  assert.equal(result.confirmed.length, 3)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [0, 0, 0])
}

// S5: failed finder -> round dry-ineligible; dry counter neither increments nor resets.
scenarios.s5_finder_failure_ineligible = async () => {
  const { result } = await run({
    args: { maxRounds: 3 },
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round === 1 && key === 'ws-hub' && model === 'opus') return { findings: [finding(1)] }
        if (round === 2 && key === 'concurrency' && model === 'opus') return null // dead finder
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.equal(result.rounds[1].dryEligible, false)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [0, 0, 1])
  assert.equal(result.converged, false)
}

// S6: failed verifier retried once, retry succeeds.
scenarios.s6_verifier_retry = async () => {
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands, isRetry) => (isRetry ? confirmAll(cands) : null),
    }),
  })
  assert.ok(calls.some((c) => (c.opts.label || '').endsWith(':retry')))
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.converged, true)
}

// S6b: verifier fails twice -> candidate dropped unconfirmed, round ineligible;
// re-reported later, verified then, and scrubbed from the unverified list.
scenarios.s6b_verifier_double_failure = async () => {
  const { result } = await run({
    args: { maxRounds: 3 },
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round === 1 && key === 'ws-hub' && model === 'opus') return { findings: [finding(3)] }
        if (round === 2 && key === 'state-desync' && model === 'opus') return { findings: [finding(3)] }
        return none
      },
      verify: (round, key, cands) => (round === 1 ? null : confirmAll(cands)),
    }),
  })
  assert.equal(result.rounds[0].dryEligible, false)
  assert.equal(result.rounds[0].confirmed, 0)
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.confirmed[0].round, 2)
  assert.equal(result.unverified.length, 0, 'later-confirmed candidate must leave the unverified list')
}

// N1 (spec #1): the top-ranked hotspot cluster sits out exactly the next round, then returns.
// The producing cluster keeps running when eligible (the old s7b lock, restated under cooldown).
scenarios.s_cluster_cooldown = async () => {
  const { calls } = await run({
    args: { maxRounds: 6, dryThreshold: 9, graph: graphRows(60) },
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round === 1 && key === 'ws-hub')
          return { findings: [
            finding(1, { file: 'Server/ws/hub.go', title: 'ws bug alpha one' }),
            finding(2, { file: 'Server/ws/pubsub.go', line: 300, title: 'ws bug beta two' }),
          ] }
        if (round === 2 && key === 'concurrency')
          return { findings: [
            finding(3, { file: 'Server/ws/emit.go', title: 'ws bug gamma three' }),
            finding(4, { file: 'Server/api/user.go', title: 'api bug delta four' }),
          ] }
        if (round === 4 && key === 'hotspot-server-ws')
          return { findings: [finding(9, { file: 'Server/ws/late.go', title: 'late ws bug nine' })] }
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const hunted = (rnd, key) => calls.some((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`)
  assert.ok(hunted(4, 'hotspot-server-ws'), 'top cluster hunts in r4')
  assert.ok(!hunted(5, 'hotspot-server-ws'), 'the r4 top cluster must sit out r5 even though it produced')
  assert.ok(hunted(5, 'hotspot-server-api'), 'the next cluster takes the top slot in r5')
  assert.ok(hunted(6, 'hotspot-server-ws'), 'cooldown lasts exactly one round')
}

// N2 (spec #2): a cooldown gap FREEZES cleanStreak - neither increments nor resets - so
// demotion still means two consecutive clean APPEARANCES. If the gap incremented, ws would
// be demoted before r6; if demotion broke, ws would still run in r8.
scenarios.s_cooldown_freezes_streak = async () => {
  const { result, calls } = await run({
    args: { maxRounds: 8, dryThreshold: 9, graph: graphRows(100) },
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round === 1 && key === 'ws-hub')
          return { findings: [
            finding(1, { file: 'Server/ws/hub.go', title: 'ws bug alpha one' }),
            finding(2, { file: 'Server/ws/pubsub.go', line: 300, title: 'ws bug beta two' }),
          ] }
        if (round === 2 && key === 'concurrency')
          return { findings: [finding(3, { file: 'Server/api/user.go', title: 'api bug delta three' })] }
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const hunted = (rnd, key) => calls.some((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`)
  assert.ok(hunted(4, 'hotspot-server-ws'), 'clean appearance #1 in r4')
  assert.ok(!hunted(5, 'hotspot-server-ws'), 'cooldown in r5')
  assert.ok(hunted(6, 'hotspot-server-ws'), 'the gap must freeze the streak at 1, not increment it')
  assert.equal(result.rounds.length, 8, 'the run must reach r8 for the demotion assert to mean anything')
  assert.ok(!hunted(8, 'hotspot-server-ws'), 'two clean appearances (r4, r6) demote the lens')
}

// N3 (spec #3): cooldown+demotion emptying the hotspot pool must backfill from explore and
// log it - silent family shrinkage is the exact freshEyesLens() defect this rebuild removes.
scenarios.s_hotspot_backfill = async () => {
  const { calls, logs } = await run({
    args: { maxRounds: 5, dryThreshold: 9, graph: graphRows(100) },
    agentStub: makeStub({
      hunt: (round, key) =>
        round === 1 && key === 'ws-hub'
          ? { findings: [finding(1, { file: 'Server/ws/hub.go', title: 'lone ws bug one' })] }
          : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const r5 = calls.filter((c) => /^r5:hunt:/.test(c.opts.label || '')).map((c) => c.opts.label.split(':')[2])
  assert.ok(!r5.some((k) => k.startsWith('hotspot-')), 'the sole cluster is on cooldown in r5')
  assert.deepEqual([...r5].sort(), ['explore-1', 'explore-2', 'explore-3', 'explore-4'], 'the family backfills to full size from explore')
  assert.ok(logs.some((l) => /hotspot pool short/.test(l)), 'backfill must be logged, never silent')
}

// N4 (spec #4): within-run consumption - later rounds draw the NEXT chunk of the ranking,
// never re-offering files already handed to an explore lens this run.
scenarios.s_explore_consumption = async () => {
  const { calls } = await run({
    args: { maxRounds: 5, dryThreshold: 9, graph: graphRows(80) },
    agentStub: makeStub({
      hunt: (round, key) =>
        round === 1 && key === 'ws-hub'
          ? { findings: [finding(1, { file: 'Server/ws/hub.go', title: 'seed bug one' })] }
          : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const promptOf = (rnd, key) => (calls.find((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`) || {}).prompt || ''
  assert.match(promptOf(4, 'explore-1'), /Server\/gen\/g0\.go/)
  assert.match(promptOf(4, 'explore-2'), /Server\/gen\/g10\.go/)
  assert.match(promptOf(4, 'explore-3'), /Server\/gen\/g20\.go/, 'r4 backfills a third explore lens (single cluster)')
  assert.match(promptOf(5, 'explore-1'), /Server\/gen\/g30\.go/, 'r5 draws the next chunk')
  assert.doesNotMatch(promptOf(5, 'explore-1'), /Server\/gen\/g0\.go/, 'r5 must not re-offer r4 files')
}

// N6 (spec #6): args.graph absent -> churn-based fresh-eyes fallback, logged, family intact.
scenarios.s_graph_missing_fallback = async () => {
  const { calls, logs } = await run({
    args: { maxRounds: 4, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key) =>
        round === 1 && key === 'ws-hub'
          ? { findings: [finding(1, { file: 'Server/ws/hub.go', title: 'seed bug one' })] }
          : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.ok(logs.some((l) => /falling back to churn/.test(l)), 'the fallback must be logged')
  const e1 = calls.find((c) => (c.opts.label || '') === 'r4:hunt:explore-1:opus')
  assert.ok(e1, 'an explore lens must still run from churn')
  assert.match(e1.prompt, /Server\/api\/user\.go/, 'churned file with no findings feeds the fallback')
}

// S7: rounds 1-3 each confirm a bug -> round 4 runs adaptive lenses: directory-granularity
// hotspots plus explore (churn fallback here - no args.graph is passed).
scenarios.s7_adaptive_lenses = async () => {
  const A = finding(1, { file: 'Server/ws/hub.go', line: 120, title: 'alpha race window one' })
  const B = finding(2, { file: 'Server/ws/pubsub.go', line: 60, title: 'beta subscription leak two' })
  const C = finding(3, { file: 'Client/tauri-client/src/lib/livekitE2EE.ts', line: 200, title: 'gamma epoch desync three' })
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round === 1 && key === 'ws-hub') return { findings: [A] }
        if (round === 2 && key === 'concurrency') return { findings: [B] }
        if (round === 3 && key === 'flow-voice') return { findings: [C] }
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.equal(result.converged, true)
  assert.equal(result.rounds.length, 5) // r4, r5 adaptive + dry
  assert.equal(result.rounds[3].family, 'adaptive')
  const r4Keys = [...new Set(calls.filter((c) => /^r4:hunt:/.test(c.opts.label || '')).map((c) => c.opts.label.split(':')[2]))]
  assert.ok(r4Keys.includes('hotspot-server-ws'), `r4 keys: ${r4Keys}`)
  assert.ok(r4Keys.includes('hotspot-client-tauri-client-src-lib'), `r4 keys: ${r4Keys}`)
  assert.ok(r4Keys.includes('explore-1'), `r4 keys: ${r4Keys}`)
  const hotspot = calls.find((c) => (c.opts.label || '').includes('hotspot-server-ws'))
  assert.match(hotspot.prompt, /Server\/ws\/hub\.go/)
  assert.match(hotspot.prompt, /alpha race window one/)
  const explore = calls.find((c) => (c.opts.label || '') === 'r4:hunt:explore-1:opus')
  assert.match(explore.prompt, /Server\/api\/user\.go/) // churned, never a finding
  assert.equal(result.confirmed.length, 3)
}

// S7c: a lens whose VERIFIER died is not demoted (its cluster returns after cooldown);
// a zero-candidate explore lens still accrues streak and demotes.
scenarios.s7c_verifier_failure_not_demoted = async () => {
  const early = { 1: 'ws-hub', 2: 'concurrency', 3: 'flow-reconnect' }
  const { result, calls } = await run({
    args: { maxRounds: 6, dryThreshold: 9, graph: graphRows(100) },
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round <= 3 && key === early[round])
          return { findings: [finding(round, { file: `Server/ws/a${round}.go`, title: `early bug item${round} kappa${round}` })] }
        if (round >= 4 && key === 'hotspot-server-ws')
          return { findings: [finding(round + 10, { file: `Server/ws/b${round}.go`, title: `late bug item${round} sigma${round}` })] }
        return none
      },
      verify: (round, key, cands) => (round <= 3 ? confirmAll(cands) : null),
    }),
  })
  const labels = calls.map((c) => c.opts.label || '')
  assert.ok(labels.some((l) => /^r4:hunt:hotspot-server-ws:/.test(l)))
  assert.ok(!labels.some((l) => /^r5:hunt:hotspot-server-ws:/.test(l)), 'cooldown after topping r4')
  assert.ok(labels.some((l) => /^r6:hunt:hotspot-server-ws:/.test(l)), 'a verifier-dead lens must NOT be demoted')
  assert.ok(!labels.some((l) => /^r6:hunt:explore-1:/.test(l)), 'a zero-candidate explore lens still demotes')
  assert.equal(result.confirmed.length, 3)
  assert.equal(result.unverified.length, 2) // b4 and b6, each denied a verdict twice
  assert.equal(result.converged, false)
  assert.equal(result.rounds[3].dryEligible, false)
  assert.equal(result.rounds[5].dryEligible, false)
}

// S12: empty adaptive family (no confirms, no churn) must break honestly, not count dry rounds.
scenarios.s12_empty_adaptive_family = async () => {
  const { result } = await run({
    agentStub: makeStub({
      recon: () => 'no parseable churn output',
      hunt: (round, key, model) => {
        if (round <= 2 && key === (round === 1 ? 'ws-hub' : 'concurrency') && model === 'opus')
          return { findings: [finding(round, { file: `Server/ws/c${round}.go`, title: `verifierless bug delta${round} theta${round}` })] }
        return none
      },
      verify: () => null,
    }),
  })
  assert.equal(result.rounds.length, 3)
  assert.equal(result.converged, false)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.unverified.length, 2)
}

// S8: budget below the round floor before round 1 -> zero rounds, honest non-convergence.
scenarios.s8_budget_floor = async () => {
  const { result, calls } = await run({
    budget: { total: 1000000, spent: () => 900000, remaining: () => 100000 },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  assert.equal(result.rounds.length, 0)
  assert.equal(result.stoppedOnBudget, true)
  assert.equal(result.converged, false)
  assert.ok(!calls.some((c) => /:hunt:/.test(c.opts.label || '')))
  assert.match(result.report, /budget/i)
}

// S8c: budget.total null (directive failed to arm) but args.budgetTotal supplied ->
// ceiling armed from args, announced in the config log, computed from spent().
scenarios.s8c_budget_args_fallback = async () => {
  const { result, logs } = await run({
    args: { budgetTotal: 10000000 },
    budget: { total: null, spent: () => 9500000, remaining: () => Infinity },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  assert.equal(result.rounds.length, 0)
  assert.equal(result.stoppedOnBudget, true)
  assert.ok(logs.some((l) => /budget=10M/.test(l)), 'args-armed ceiling must announce 10M, not NONE')
  assert.equal(result.runStats.config.budgetTotal, 10000000)
}

// S8b: budget runs low mid-hunt -> finishes the round it started, stops before the next.
scenarios.s8b_budget_midrun = async () => {
  let n = 0
  const { result } = await run({
    budget: { total: 10000000, spent: () => 0, remaining: () => (n++ === 0 ? 3000000 : 400000) },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.equal(result.rounds.length, 1)
  assert.equal(result.stoppedOnBudget, true)
  assert.equal(result.converged, false)
  assert.equal(result.confirmed.length, 1)
}

// S14: the title-word dedupe branch applies only near the prior's location.
// Dedupe is permanent, so merging two distinct same-file bugs that happen to
// share half their title words loses the second one forever.
scenarios.s14_title_dedupe_window = async () => {
  const near = { file: 'Server/ws/hub.go', line: 140, title: 'hub client map race on register path' }
  const far = { file: 'Server/ws/hub.go', line: 900, title: 'hub client map race on unregister' }
  const verifyBatches = []
  const { result } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (model !== 'opus') return none
        if (round === 1 && key === 'ws-hub')
          return { findings: [finding(1, { file: 'Server/ws/hub.go', line: 100, title: 'hub client map race on register' })] }
        if (round === 2 && key === 'concurrency')
          return { findings: [finding(2, far), finding(3, near)] }
        return none
      },
      verify: (round, key, cands) => {
        verifyBatches.push(cands.map((c) => c.line))
        return confirmAll(cands)
      },
    }),
  })
  assert.deepEqual(verifyBatches, [[100], [900]], 'near-duplicate dropped, distant same-file bug kept')
  assert.equal(result.confirmed.length, 2)
  assert.ok(result.confirmed.some((c) => c.line === 900), 'the distant bug must survive dedupe')
}

// S13: JSON-stringified args must behave identically to object args (observed live: the
// runtime can deliver args as a string; maxRounds:1 silently fell back to 8 before the coercion).
scenarios.s13_string_args = async () => {
  const { result, calls } = await run({
    args: '{"maxRounds": 1}',
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  assert.equal(result.rounds.length, 1, 'string maxRounds:1 must cap the loop at one round')
  assert.equal(result.converged, false)
  assert.equal(result.confirmed.length, 1)
  assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('r2:')), 'no round 2 under the cap')
}

// S10: verifier returns truncated (empty) verdict lists on both attempts ->
// candidates land in unverified, round ineligible, dry counter untouched.
scenarios.s10_truncated_verdicts = async () => {
  const { result, calls } = await run({
    args: { maxRounds: 2 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: () => ({ verdicts: [] }),
    }),
  })
  assert.ok(calls.some((c) => (c.opts.label || '').endsWith(':retry')), 'short verdict list must trigger the retry')
  assert.equal(result.rounds[0].dryEligible, false)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [0, 1])
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.unverified.length, 1)
  assert.equal(result.converged, false)
}

// S11: verdict coordinates drift from the candidate's -> still pairs, confirms once,
// nothing listed unverified, and a round-2 re-report of the ORIGINAL coords is deduped.
scenarios.s11_drifted_verdict = async () => {
  const orig = finding(4) // file Server/ws/hub.go, line 260
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round === 1 && key === 'ws-hub' && model === 'opus') return { findings: [orig] }
        if (round === 2 && key === 'state-desync' && model === 'opus') return { findings: [orig] }
        return none
      },
      verify: (round, key, cands) => ({
        verdicts: cands.map((c) => ({
          title: c.title, file: c.file, line: c.line + 5,
          refuted: false, reason: 'confirmed', confidence: 'high', severity: 'high', fix: 'fix',
        })),
      }),
    }),
  })
  const verifyRounds = calls
    .map((c) => /^r(\d+):verify:/.exec(c.opts.label || ''))
    .filter(Boolean)
    .map((m) => Number(m[1]))
  assert.deepEqual(verifyRounds, [1], 'drifted-but-paired verdict must still suppress the original coords')
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.unverified.length, 0)
  assert.equal(result.converged, true)
}

// S-known: a finding already in the ledger is suppressed - never verified, never re-confirmed,
// and its text appears in the finder prompt so the model does not spend effort re-deriving it.
scenarios.s_known_ledger_suppresses = async () => {
  const known = [
    { file: 'Server/ws/hub.go', line: 140, title: 'distinct bug alpha1 omega1', status: 'declined' },
  ]
  const { result, calls } = await run({
    args: { known, maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const huntPrompts = calls.filter((c) => /:hunt:/.test(c.opts.label || '')).map((c) => c.prompt)
  assert.ok(huntPrompts.length > 0, 'expected at least one finder call')
  assert.match(huntPrompts[0], /KNOWN FINDINGS/, 'ledger entries must reach the finder prompt')
  assert.match(huntPrompts[0], /\[declined\] distinct bug alpha1 omega1/)
  assert.ok(
    !calls.some((c) => /:verify:/.test(c.opts.label || '')),
    'a ledger-known candidate must not reach verification',
  )
  assert.equal(result.confirmed.length, 0)
}

// S-lenses: args.lenses replaces the round-1 family entirely, and the round label reflects it.
scenarios.s_custom_lenses = async () => {
  const lenses = [
    { key: 'voice-e2ee-keyholder', prompt: 'Hunt the key-holder election.' },
    { key: 'voice-e2ee-rotation', prompt: 'Hunt the rotation paths.' },
  ]
  const { result, calls } = await run({
    args: { lenses, maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  const keys = calls
    .map((c) => /^r1:hunt:([a-z0-9-]+):opus$/.exec(c.opts.label || ''))
    .filter(Boolean)
    .map((m) => m[1])
  assert.deepEqual([...new Set(keys)].sort(), ['voice-e2ee-keyholder', 'voice-e2ee-rotation'])
  assert.ok(!keys.includes('ws-hub'), 'the default surface family must not run when lenses are supplied')
  assert.equal(result.rounds[0].family, 'custom')
  assert.equal(result.rounds[0].lenses, 2)
}

// S-lenses-default: omitting args.lenses leaves the rotation untouched.
scenarios.s_custom_lenses_absent = async () => {
  const { result } = await run({
    args: { maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  assert.equal(result.rounds[0].family, 'surfaces')
}

// S-ledger-fields: a confirmed record must carry finder detail (why/repro/evidence) as well as
// verifier detail (severity/fix), because the ledger needs both.
scenarios.s_confirmed_carries_finder_detail = async () => {
  const cand = {
    title: 'distinct bug alpha1 omega1',
    file: 'Server/ws/hub.go',
    line: 140,
    severity: 'low',
    why: 'WHY_TEXT',
    repro: 'REPRO_TEXT',
    evidence: 'EVIDENCE_TEXT',
  }
  const { result } = await run({
    args: { maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [cand] } : none,
      verify: (round, key, cands) => ({
        verdicts: cands.map((c) => ({
          title: c.title, file: c.file, line: c.line,
          refuted: false, reason: 'confirmed', confidence: 'high',
          severity: 'high', fix: 'FIX_TEXT',
        })),
      }),
    }),
  })
  assert.equal(result.confirmed.length, 1)
  const r = result.confirmed[0]
  assert.equal(r.why, 'WHY_TEXT')
  assert.equal(r.repro, 'REPRO_TEXT')
  assert.equal(r.evidence, 'EVIDENCE_TEXT')
  assert.equal(r.severity, 'high', 'verifier severity must win over the finder rating')
  assert.equal(r.fix, 'FIX_TEXT')
  assert.equal(r.lens, 'ws-hub')
  assert.equal(r.round, 1)
  assert.equal(r.finder, 'opus', 'the finder tag is constant now but the ledger still expects it')
}

// S_VERIFIER_IS_NOT_TOLD_THE_FINDER: the verifier prompt deliberately says "another model" and
// never names it. Leaking the attribution tag would tell a refute-by-default verifier that opus
// found something, which is exactly the kind of authority cue that erodes refute-by-default.
scenarios.s_verifier_is_not_told_the_finder = async () => {
  let verifyPromptText = ''
  await run({
    args: { maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands, retry, prompt) => {
        verifyPromptText = prompt
        return confirmAll(cands)
      },
    }),
  })
  assert.ok(verifyPromptText, 'the verifier must have been called')
  assert.doesNotMatch(verifyPromptText, /finder/i, 'the verifier must not be told which model found the candidate')
  // Guard against over-stripping: the fields the verifier actually needs must survive.
  for (const field of ['title', 'file', 'line', 'why', 'repro', 'evidence']) {
    assert.match(verifyPromptText, new RegExp(`"${field}"`), `candidates must still carry ${field}`)
  }
}

// New (spec Testing #8): the report is built in-script. Section count must equal the confirmed
// count at 82 (the agent version emitted 79 for 82), and the unverified section must survive
// the agent's removal - it used to exist only inside the report agent's prompt.
scenarios.s_report_deterministic = async () => {
  const many = Array.from({ length: 82 }, (_, i) =>
    finding(i, { file: `Server/ws/f${i}.go`, line: 10, title: `unique bug row${i} tag${i}` }))
  const stuck = finding(999, { file: 'Server/api/stuck.go', line: 40, title: 'stuck bug never verified' })
  const { result, calls } = await run({
    args: { maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [...many, stuck] } : none,
      verify: (round, key, cands) => confirmAll(cands.filter((c) => c.file !== 'Server/api/stuck.go')),
    }),
  })
  assert.equal(result.confirmed.length, 82)
  assert.equal(result.unverified.length, 1)
  assert.ok(!calls.some((c) => c.opts.label === 'report'), 'no report agent may run')
  const sections = (result.report.match(/^### /gm) || []).length
  assert.equal(sections, 82, 'one section per confirmed finding, none dropped')
  assert.match(result.report, /## Unverified - re-run/)
  assert.match(result.report, /stuck bug never verified/)
  assert.match(result.report, /## Convergence/)
}

// New (spec Testing #7): the retry re-sends ONLY unmatched candidates, and N garbage verdicts
// (count == candidate count, zero of them matching) must still trigger it - the hole S10 misses
// because S10's verdict list is empty rather than full of junk.
scenarios.s_targeted_retry = async () => {
  const a = finding(1, { file: 'Server/ws/a.go', title: 'alpha bug one paired' })
  const b = finding(2, { file: 'Server/api/b.go', title: 'beta bug two orphaned' })
  const retryBatches = []
  const { result } = await run({
    args: { maxRounds: 1, dryThreshold: 9 },
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [a, b] } : none,
      verify: (round, key, cands, isRetry) => {
        if (isRetry) {
          retryBatches.push(cands)
          return confirmAll(cands)
        }
        // one real verdict for a, one garbage verdict pointing nowhere: count matches, content doesn't
        return {
          verdicts: [
            { title: a.title, file: a.file, line: a.line, refuted: false, reason: 'ok', confidence: 'high', severity: 'high', fix: 'f' },
            { title: 'hallucinated', file: 'Server/nowhere.go', line: 1, refuted: false, reason: 'x', confidence: 'low', severity: 'low' },
          ],
        }
      },
    }),
  })
  assert.equal(retryBatches.length, 1, 'retry must fire despite verdict count == candidate count')
  assert.deepEqual(retryBatches[0].map((c) => c.file), ['Server/api/b.go'], 'only the unmatched candidate is re-sent')
  assert.equal(result.confirmed.length, 2)
  assert.equal(result.unverified.length, 0)
}

// New (spec Testing #9): the retuned floor must stop a run the old 150k floor let through.
// A single opus finder round costs ~100-260k (2026-08-13 run); 400k remaining is under the
// 600k floor, so starting another round could overshoot the ceiling - stop instead.
scenarios.s9_budget_ceiling_retuned = async () => {
  const { result, logs } = await run({
    budget: { total: 10000000, spent: () => 9600000, remaining: () => 400000 },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  assert.equal(result.rounds.length, 0, '400k remaining must not start a round under the 600k floor')
  assert.equal(result.stoppedOnBudget, true)
  assert.ok(logs.some((l) => /Budget floor/.test(l)))
}

// New: telemetry. Per-round suppression split (ledger vs same-run), spend sampling, file
// coverage, severity mix, per-lens precision, and the top-level runStats aggregate. Without
// this every cost figure from a run is eyewitness-only - the 2026-08-12 problem.
scenarios.s_telemetry = async () => {
  let spent = 0
  const known = [{ file: 'Server/ws/hub.go', line: 100, title: 'known bug from ledger prior', status: 'fixed' }]
  const { result } = await run({
    args: { maxRounds: 1, dryThreshold: 9, known },
    budget: { total: 50000000, spent: () => (spent += 500000), remaining: () => 40000000 },
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round !== 1 || key !== 'ws-hub' || model !== 'opus') return none
        return { findings: [
          finding(1, { file: 'Server/ws/hub.go', line: 102, title: 'known bug from ledger prior' }),
          finding(2, { file: 'Server/api/fresh.go', severity: 'medium', title: 'fresh bug beta gamma' }),
        ] }
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const r1 = result.rounds[0]
  assert.equal(r1.suppressedLedger, 1, 'the ledger-known duplicate must be counted as ledger suppression')
  assert.equal(r1.suppressedRun, 0)
  assert.ok(r1.spentAfter > r1.spentBefore, 'per-round spend must be sampled')
  assert.equal(r1.filesTouched, 1)
  assert.equal(r1.filesNew, 1)
  assert.deepEqual(r1.severity, { critical: 0, high: 0, medium: 1, low: 0 })
  assert.equal(r1.perLens['ws-hub'].confirmed, 1)
  assert.equal(r1.perLens['ws-hub'].fresh, 1)
  assert.ok(result.runStats, 'runStats missing from the result')
  assert.equal(result.runStats.confirmed, 1)
  assert.equal(result.runStats.suppressedLedger, 1)
  assert.equal(result.runStats.config.maxRounds, 1)
  assert.match(result.report, /## Run stats/)
}

// N7 (Task 9 review finding): a dead finder on an explore lens read nothing - its draw is
// rewound so the files never reach exploredFiles, where the session would record them clean
// and deprioritize them in every future hunt. maxRounds caps at 4 on purpose: a live round-5
// lens would legitimately re-read the rewound files and they would CORRECTLY re-enter
// exploredFiles - the poison-prevention property is only assertable when the run ends here.
// Re-offering in later rounds follows from the same exploreConsumed state drawExploreFiles
// filters on, so this one scenario locks the mechanism.
scenarios.s_explore_rewind_on_dead_finder = async () => {
  const { result, calls } = await run({
    args: { maxRounds: 4, dryThreshold: 9, graph: graphRows(80) },
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round === 1 && key === 'ws-hub')
          return { findings: [finding(1, { file: 'Server/ws/hub.go', title: 'seed bug one' })] }
        if (round === 4 && key === 'explore-1') return null // dead finder: read nothing
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const promptOf = (rnd, key) => (calls.find((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`) || {}).prompt || ''
  assert.match(promptOf(4, 'explore-1'), /Server\/gen\/g0\.go/, 'r4 explore-1 drew the head of the ranking')
  for (let i = 0; i < 10; i++)
    assert.ok(!result.exploredFiles.includes(`Server/gen/g${i}.go`), `g${i} was never read - must not be reported explored`)
  assert.ok(result.exploredFiles.includes('Server/gen/g10.go'), 'files a LIVE lens drew stay reported')
  assert.ok(result.exploredFiles.includes('Server/gen/g20.go'), 'backfilled live lens files stay reported too')
}

// N8 (final-review finding): a THROWN stage nulls the whole lens result - the second
// finder-failure mode the code documents. Its explore draw must rewind exactly like the
// null-finder case, or never-read files reach exploredFiles and poison explored-clean.
scenarios.s_explore_rewind_on_thrown_stage = async () => {
  const { result, calls } = await run({
    args: { maxRounds: 4, dryThreshold: 9, graph: graphRows(80) },
    agentStub: makeStub({
      hunt: (round, key) => {
        if (round === 1 && key === 'ws-hub')
          return { findings: [finding(1, { file: 'Server/ws/hub.go', title: 'seed bug one' })] }
        if (round === 4 && key === 'explore-1') throw new Error('finder infrastructure blew up')
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const promptOf = (rnd, key) => (calls.find((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`) || {}).prompt || ''
  assert.match(promptOf(4, 'explore-1'), /Server\/gen\/g0\.go/, 'r4 explore-1 drew the head of the ranking')
  for (let i = 0; i < 10; i++)
    assert.ok(!result.exploredFiles.includes(`Server/gen/g${i}.go`), `g${i} was never read - must not be reported explored`)
  assert.ok(result.exploredFiles.includes('Server/gen/g10.go'), 'files a LIVE lens drew stay reported')
  assert.equal(result.rounds[3].dryEligible, false, 'a nulled lens result still makes the round ineligible')
}

// COV1 (spec §3): coverage mode may NOT stop on quietness while inventory files are uncovered.
// 60 rows, 10 pre-examined -> 50 to sweep. Nothing is ever found, so dry passes the threshold
// at round 2 - the old stop rule would have converged there. The new rule keeps going until
// round 4's explore lenses (quota 4 + backfill 2 slots; 5 draw files, the 6th comes up empty)
// cover all 50, then exits. Also locks the enriched explore prompt (class checklist).
scenarios.s_coverage_blocks_stop = async () => {
  const inv = inventoryRows(60, (i) => (i >= 50 ? { examined: true } : {}))
  const { result, calls } = await run({
    args: { graph: inv },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  assert.equal(result.rounds.length, 4, 'must run past the dry threshold (hit at r2) to sweep in r4')
  assert.equal(result.converged, true)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [1, 2, 3, 4])
  assert.deepEqual(result.runStats.coverage, { inventory: 60, preCovered: 10, covered: 60, uncoveredAtStop: 0 })
  assert.match(result.report, /CONVERGED/)
  const ep = (calls.find((c) => (c.opts.label || '') === 'r4:hunt:explore-1:opus') || {}).prompt || ''
  assert.match(ep, /error-path data loss/, 'explore lenses carry the distilled class checklist')
}

// COV2 (spec §2+§4): a dead explore finder's files stay uncovered and get re-offered; the
// run only converges after a LIVE lens covers them.
scenarios.s_coverage_dead_finder = async () => {
  const inv = inventoryRows(20)
  const { result, calls } = await run({
    args: { graph: inv },
    agentStub: makeStub({
      hunt: (round, key) => (round === 4 && key === 'explore-1' ? null : none),
      verify: (r, k, c) => confirmAll(c),
    }),
  })
  const promptOf = (rnd, key) => (calls.find((c) => (c.opts.label || '') === `r${rnd}:hunt:${key}:opus`) || {}).prompt || ''
  assert.match(promptOf(4, 'explore-1'), /Server\/gen\/g0\.go/, 'r4 explore-1 drew the head of the pool')
  assert.match(promptOf(5, 'explore-1'), /Server\/gen\/g0\.go/, 'dead lens files are re-offered next round')
  assert.equal(result.rounds[3].dryEligible, false, 'dead finder keeps the round ineligible')
  assert.equal(result.converged, true)
  assert.deepEqual(result.runStats.coverage, { inventory: 20, preCovered: 0, covered: 20, uncoveredAtStop: 0 })
}

// COV7 (amendment 4): explore draws are directory-coherent - one lens reads one module,
// not ten strangers. Cross-file classes (state desync, acquire/release pairs) need siblings
// in one agent's context.
scenarios.s_directory_coherent_draws = async () => {
  const inv = inventoryRows(20, (i) => ({ file: i % 2 === 0 ? `Server/alpha/a${i}.go` : `Server/beta/b${i}.go` }))
  const { calls } = await run({
    args: { graph: inv },
    agentStub: makeStub({ hunt: () => none, verify: (r, k, c) => confirmAll(c) }),
  })
  const p1 = (calls.find((c) => (c.opts.label || '') === 'r4:hunt:explore-1:opus') || {}).prompt || ''
  assert.match(p1, /Server\/alpha\/a0\.go/)
  assert.match(p1, /Server\/alpha\/a18\.go/, 'all ten alpha files ride in the first lens')
  assert.doesNotMatch(p1, /Server\/beta\//, 'no stranger directories in a coherent draw')
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
