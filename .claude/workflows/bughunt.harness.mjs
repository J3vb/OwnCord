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
export function makeStub({ hunt, verify, report = () => 'REPORT_MD', recon = defaultRecon }) {
  return (prompt, opts) => {
    const label = opts.label || ''
    if (label.startsWith('recon:')) return recon(label)
    let m = /^r(\d+):hunt:([a-z0-9-]+):(opus|sonnet)$/.exec(label)
    if (m) return hunt(Number(m[1]), m[2], m[3], prompt)
    m = /^r(\d+):verify:([a-z0-9-]+?)(:retry)?$/.exec(label)
    if (m) {
      const candidates = JSON.parse(prompt.split('--- CANDIDATES ---')[1])
      return verify(Number(m[1]), m[2], candidates, Boolean(m[3]), prompt)
    }
    if (label === 'report') return report(prompt)
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
  const reportPrompts = []
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) =>
        round === 1 && key === 'ws-hub' && model === 'opus' ? { findings: [finding(1)] } : none,
      verify: (round, key, cands) => confirmAll(cands),
      report: (prompt) => {
        reportPrompts.push(prompt)
        return 'REPORT_MD'
      },
    }),
  })
  for (const k of ['converged', 'stoppedOnBudget', 'rounds', 'confirmed', 'unverified', 'report'])
    assert.ok(k in result, `missing key ${k}`)
  assert.equal(result.converged, true)
  assert.equal(result.rounds.length, 3)
  assert.deepEqual(result.rounds.map((r) => r.dryAfter), [0, 1, 2])
  assert.deepEqual(result.rounds.map((r) => r.family), ['surfaces', 'bug-classes', 'flows'])
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.report, 'REPORT_MD')
  assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('r4:')), 'no round 4 after convergence')
  assert.match(reportPrompts[0], /CONVERGED after 3 round\(s\)/)
  assert.match(reportPrompts[0], /\| 1 \| surfaces \|/)
}

// S2: panel dedupe - opus and sonnet report the same bug -> one candidate, one verify call.
scenarios.s2_panel_dedupe = async () => {
  const verifyBatches = []
  const { result } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (round !== 1 || key !== 'ws-hub') return none
        return model === 'opus'
          ? { findings: [finding(1, { line: 100 })] }
          : { findings: [finding(1, { line: 105, title: 'distinct bug alpha1 omega1 variant' })] }
      },
      verify: (round, key, cands) => {
        verifyBatches.push(cands)
        return confirmAll(cands)
      },
    }),
  })
  assert.equal(verifyBatches.length, 1)
  assert.equal(verifyBatches[0].length, 1)
  assert.equal(result.confirmed.length, 1)
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

// S7: rounds 1-3 each confirm a bug -> round 4 runs adaptive lenses built from the stats.
scenarios.s7_adaptive_lenses = async () => {
  const A = finding(1, { file: 'Server/ws/hub.go', line: 120, title: 'alpha race window one' })
  const B = finding(2, { file: 'Server/ws/pubsub.go', line: 60, title: 'beta subscription leak two' })
  const C = finding(3, { file: 'Client/tauri-client/src/lib/livekitE2EE.ts', line: 200, title: 'gamma epoch desync three' })
  const { result, calls } = await run({
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (model !== 'opus') return none
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
  const r4Hunts = calls.filter((c) => /^r4:hunt:/.test(c.opts.label || ''))
  const r4Keys = [...new Set(r4Hunts.map((c) => c.opts.label.split(':')[2]))]
  assert.ok(r4Keys.includes('hotspot-server-ws'), `r4 keys: ${r4Keys}`)
  assert.ok(r4Keys.includes('fresh-eyes'), `r4 keys: ${r4Keys}`)
  const hotspot = r4Hunts.find((c) => c.opts.label.includes('hotspot-server-ws'))
  assert.match(hotspot.prompt, /Server\/ws\/hub\.go/)
  assert.match(hotspot.prompt, /alpha race window one/)
  const freshEyes = r4Hunts.find((c) => c.opts.label.includes('fresh-eyes'))
  assert.match(freshEyes.prompt, /Server\/api\/user\.go/) // churned, never a finding
  assert.equal(result.confirmed.length, 3)
}

// S7b: a lens with 2 consecutive clean rounds is demoted from later rounds.
scenarios.s7b_demotion = async () => {
  const { result, calls } = await run({
    args: { maxRounds: 6 },
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (model !== 'opus') return none
        const src = { 1: 'ws-hub', 2: 'concurrency', 3: 'flow-reconnect', 4: 'hotspot-server-ws', 5: 'hotspot-server-ws' }
        if (key === src[round])
          return { findings: [finding(round, { file: `Server/ws/a${round}.go`, title: `unique bug number${round} zeta${round}` })] }
        return none
      },
      verify: (round, key, cands) => confirmAll(cands),
    }),
  })
  const labels = calls.map((c) => c.opts.label || '')
  assert.ok(labels.some((l) => /^r5:hunt:fresh-eyes:/.test(l)), 'fresh-eyes still runs in r5 (streak 1)')
  assert.ok(!labels.some((l) => /^r6:hunt:fresh-eyes:/.test(l)), 'fresh-eyes demoted in r6 (streak 2)')
  assert.ok(labels.some((l) => /^r6:hunt:hotspot-server-ws:/.test(l)), 'producing hotspot keeps running')
  assert.equal(result.converged, false)
  assert.equal(result.confirmed.length, 5)
}

// S7c: a lens whose VERIFIER died is not demoted; a zero-candidate lens still is.
scenarios.s7c_verifier_failure_not_demoted = async () => {
  const early = { 1: 'ws-hub', 2: 'concurrency', 3: 'flow-reconnect' }
  const { result, calls } = await run({
    args: { maxRounds: 6 },
    agentStub: makeStub({
      hunt: (round, key, model) => {
        if (model !== 'opus') return none
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
  assert.ok(labels.some((l) => /^r6:hunt:hotspot-server-ws:/.test(l)), 'verifier-dead lens must NOT be demoted')
  assert.ok(!labels.some((l) => /^r6:hunt:fresh-eyes:/.test(l)), 'zero-candidate lens still accrues streak and demotes')
  assert.equal(result.confirmed.length, 3)
  assert.equal(result.unverified.length, 3)
  assert.equal(result.converged, false)
  assert.ok(result.rounds.slice(3).every((r) => r.dryEligible === false))
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

// S8b: budget runs low mid-hunt -> finishes the round it started, stops before the next.
scenarios.s8b_budget_midrun = async () => {
  let n = 0
  const { result } = await run({
    budget: { total: 1000000, spent: () => 0, remaining: () => (n++ === 0 ? 200000 : 100000) },
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
