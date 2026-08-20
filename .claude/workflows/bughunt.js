export const meta = {
  name: 'bughunt',
  description: 'Converging multi-round bug hunt: rotating lens families, single opus finder, opus refute-by-default verification, dry-threshold stop',
  whenToUse: 'Hunting real bugs across the Go server, Tauri Rust backend, and TS client until consecutive rounds go dry. Not a security-only scan.',
  phases: [
    { title: 'Recon', detail: 'haiku: churn + concurrency-surface inventory' },
  ],
}

// ---------- config ----------
// args may arrive JSON-stringified (observed in run wf_9199e623-b83: maxRounds:1 never took) - coerce
const ARGS = (() => {
  if (typeof args === 'string') {
    try { return JSON.parse(args) || {} } catch { return {} }
  }
  return args || {}
})()
const MAX_ROUNDS = ARGS.maxRounds || 30
const DRY_THRESHOLD = ARGS.dryThreshold || 2
// A scoped hunt (args.lenses) replaces the round-1 family outright; later rounds still go
// adaptive, so hotspot and explore coverage - and therefore convergence - still work.
const CUSTOM_LENSES = Array.isArray(ARGS.lenses) && ARGS.lenses.length ? ARGS.lenses : null
// Floor for one round. The single opus finder (sonnet retired 2026-08-12) costs ~100-260k per
// round, measured across the 8-round 2026-08-13 run. The old 2M floor was a dual-finder-era
// anchor (~2.6M/round) that would zero-out any hunt launched with a budget under 2M - now that
// budgetTotal is a first-class arg, that cliff is a foot-gun. 600k is ~3x a measured round.
const ROUND_BUDGET_FLOOR = 600000
// The turn directive failed to arm budget.total on the 2026-08-13 live run (+25M present,
// total still null), so args.budgetTotal is the deterministic fallback. budget.spent()
// works even when total is null; budget.remaining() stays authoritative when the
// directive DID arm, because stubs (and the runtime) may track it statefully.
const BUDGET_TOTAL = budget.total || Number(ARGS.budgetTotal) || null
const remainingBudget = () => (budget.total ? budget.remaining() : BUDGET_TOTAL ? Math.max(0, BUDGET_TOTAL - budget.spent()) : Infinity)
// The args channel has already been observed delivering something the script
// could not read; an unnoticed fallback here is an 8x cost surprise, so say out
// loud what the run is actually going to do.
log(`config: maxRounds=${MAX_ROUNDS} dryThreshold=${DRY_THRESHOLD}${CUSTOM_LENSES ? ` lenses=custom(${CUSTOM_LENSES.length})` : ''} budget=${BUDGET_TOTAL ? Math.round(BUDGET_TOTAL / 1e6) + 'M' : 'NONE - cost ceiling disarmed'}`)

// ---------- schemas: copied VERBATIM from the current bughunt.js ----------
const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'line', 'severity', 'why', 'repro'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          why: { type: 'string', description: 'the defect, one or two sentences' },
          repro: { type: 'string', description: 'concrete inputs/interleaving -> wrong behavior' },
          evidence: { type: 'string', description: 'the code lines that prove it' },
        },
      },
    },
  },
}

const VERDICTS = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'line', 'refuted', 'reason', 'confidence', 'severity'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          refuted: { type: 'boolean' },
          reason: { type: 'string', description: 'what refutes it, or what confirms it in the code' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          fix: { type: 'string', description: 'smallest correct fix, if confirmed' },
        },
      },
    },
  },
}

// ---------- rules ----------
const RULES = `
Repo: OwnCord, checked out at your current working directory (the repo root - do not assume any absolute
path; run every command from there and use repo-relative paths). Go 1.26 server in Server/, Tauri v2 client in Client/tauri-client/
(Rust in src-tauri/src/, TypeScript in src/lib/ and src/stores/).

You are hunting REAL BUGS: wrong behavior, not style. In scope:
  - logic errors, off-by-one, wrong operator, inverted condition, wrong default
  - concurrency: data races, deadlocks, lock-order inversion, missed wakeups, goroutine leaks, TOCTOU
  - lifecycle: use-after-close, double-close, nil deref on error paths, leaked resources/listeners/timers
  - state machines that can reach an unintended state, or desync between two sources of truth
  - error paths that silently swallow, lose data, or leave partial writes
  - auth/authz checks reading stale state, or missing on one path while present on siblings

Out of scope, do not report: naming, formatting, missing tests, "consider adding", speculative hardening,
performance that is not a hang, anything you cannot point at specific lines for.

Method:
  1. Read the actual files. Never report from a filename, a grep hit, or a graph edge alone - a
     graphify edge is structural evidence of coupling, not of a bug; open the cited file and confirm.
  2. For every candidate, grep for ALL callers before judging - a guard may already live upstream.
  3. Check whether an existing test already locks the behavior you think is wrong. If a test asserts it,
     it is intended behavior, not a bug. Test files are *_test.go and tests/unit/*.test.ts.
  4. Report EVERY finding you can prove - there is no cap. The quality bar stays: zero findings is a
     valid, respectable answer, and each finding needs file, line, and a concrete repro.

You may run read-only shell commands (grep, git log, go doc, graphify path, graphify explain).
Do not modify any file. Do not run the test suite.
`

// ---------- lens catalog ----------
// keys must match /^[a-z0-9-]+$/ - they are embedded in agent labels the harness parses.
const SURFACE_LENSES = [
  {
    key: 'ws-hub',
    prompt:
      `Surface: the WebSocket hub and its client lifecycle. Files: Server/ws/*.go (skip *_test.go) - start with ` +
      `client.go, hub*.go, emit.go, event.go, event_persister.go, event_pruner.go, handlers*.go, command.go.\n\n` +
      `Hunt specifically for: send on closed channel; write to a client after unregister; hub map mutated without ` +
      `the right lock held; lock ordering between hub and client; a goroutine that outlives its client; ` +
      `read-pump/write-pump shutdown races; events emitted to a client mid-unregister; event ordering that can ` +
      `invert under concurrent publish; pruner racing the persister over the same rows.\n` +
      `Trace at least one full connect -> subscribe -> emit -> disconnect path end to end before reporting anything.`,
  },
  {
    key: 'voice-e2ee',
    prompt:
      `Surface: voice/video E2EE key lifecycle, spanning three languages. Files: Server/ws/handler_v2_voice*.go and ` +
      `any Server/ws/*voice*.go or *e2ee*.go; Client/tauri-client/src/lib/e2eeCrypto.ts, livekitE2EE.ts, ` +
      `livekitSession.ts, identity.ts; Client/tauri-client/src-tauri/src/tofu.rs, secret_store.rs, fallback_crypto.rs, dpapi.rs.\n\n` +
      `Hunt specifically for: a key-rotation window where a participant can decrypt after they should be excluded; ` +
      `TOFU pin re-check that reads state captured before a rotation (time-of-check/time-of-use); a participant ` +
      `joining mid-rotation getting the wrong epoch key; key material outliving the session; an error path that ` +
      `falls back to unencrypted or to a zeroed/default key; sender/receiver epoch disagreement after reconnect.\n` +
      `This area was hardened before - check git log for the relevant commits and do NOT re-report anything already fixed.`,
  },
  {
    key: 'api-authz',
    prompt:
      `Surface: REST API auth and authorization. Files: Server/api/*.go (skip *_test.go), Server/auth/*.go, ` +
      `Server/permissions/*.go.\n\n` +
      `Hunt specifically for: a permission checked against a snapshot that can go stale before it is used; ` +
      `a handler that checks channel access but not server/guild access (or vice versa); an ID taken from the ` +
      `request body when it should come from the session; sibling handlers where one path has a guard and a ` +
      `near-identical one does not; rate limiter keyed on something the caller controls; role/override resolution ` +
      `that returns allow on error instead of deny.\n` +
      `Compare handlers against each other - the strongest signal here is inconsistency between siblings.`,
  },
  {
    key: 'db-storage',
    prompt:
      `Surface: persistence. Files: Server/db/*.go (NOT db/dbgen/, that is generated), Server/db/queries/*.sql, ` +
      `Server/migrations/*.sql, Server/storage/*.go, Server/service/*.go.\n\n` +
      `Hunt specifically for: a multi-statement operation that is not in one transaction and can leave partial state; ` +
      `a tx that can be committed twice or leaked without rollback on an early return; sql.ErrNoRows treated as a ` +
      `real error or swallowed as success; a query whose SQL semantics disagree with what the caller assumes ` +
      `(LIMIT, ordering, NULL handling, JOIN dropping rows); a migration that is not idempotent or that breaks ` +
      `an older row shape; unbounded result sets read fully into memory.\n` +
      `Read the .sql alongside its Go caller - the bug is usually the gap between them.`,
  },
  {
    key: 'tauri-rust',
    prompt:
      `Surface: the Tauri Rust backend. Files: Client/tauri-client/src-tauri/src/*.rs.\n\n` +
      `Hunt specifically for: a panic reachable from a Tauri command (unwrap/expect on attacker- or ` +
      `environment-controlled input) - a panic here can take down the app; a lock held across .await; ` +
      `state in tauri::State mutated from two commands without coordination; the http_proxy / livekit_proxy / ` +
      `ws_proxy forwarding a header, URL, or origin it should filter; credentials/secret_store material logged, ` +
      `left in memory, or written unencrypted on a fallback path; ptt.rs global hook not released on shutdown.\n` +
      `For each panic you find, state exactly which input reaches it.`,
  },
  {
    key: 'client-state',
    prompt:
      `Surface: TypeScript client state and event handling. Files: Client/tauri-client/src/lib/*.ts and ` +
      `src/stores/*.ts - prioritize dispatcher.ts, reconcile.ts, read-state.ts, router.ts, roomEventHandlers.ts, ` +
      `navigation-guard.ts, rate-limiter.ts, channel-navigation.ts, and whatever the churn recon flagged.\n\n` +
      `Hunt specifically for: a listener/interval/observer registered without a matching teardown (check ` +
      `disposable.ts for the intended pattern and find who bypasses it); reconcile logic that drops or duplicates ` +
      `an entity when events arrive out of order; read-state that can mark unread messages read, or lose an unread ` +
      `count, across a reconnect; an async handler whose await lets stale state be written after a newer update ` +
      `(last-write-wins race); a route guard bypassable by a rapid navigation sequence.\n` +
      `Check tests/unit/ before reporting - much of this behavior is already test-locked.`,
  },
]

const BUGCLASS_LENSES = [
  {
    key: 'concurrency',
    prompt:
      `Bug class: concurrency and interleaving - sweep the whole repo for THIS CLASS ONLY.\n` +
      `Go (Server/): data races on maps/slices/fields shared between goroutines; lock-order inversion; ` +
      `missed wakeups; TOCTOU between a check and its use; goroutines racing shutdown; send on closed channel.\n` +
      `Rust (src-tauri/src/): a lock held across .await; tauri::State mutated from two commands without ` +
      `coordination; Arc<Mutex<_>> cloned into tasks that outlive their owner.\n` +
      `TS (src/lib/, src/stores/): two async handlers interleaving on the same store (last-write-wins after ` +
      `an await); a stale closure writing state after a newer update already landed.\n` +
      `Use the recon concurrency-surface inventory to pick files. For every candidate, name the exact interleaving.`,
  },
  {
    key: 'lifecycle',
    prompt:
      `Bug class: lifecycle and teardown - sweep the whole repo for THIS CLASS ONLY.\n` +
      `Every acquire must have a matching release on EVERY exit path: goroutines outliving their owner; ` +
      `timers/intervals/listeners/workers registered without removal (client disposable.ts is the intended ` +
      `pattern - find who bypasses it); double-close and use-after-close; teardown-order mistakes; ` +
      `Rust Drop not running (mem::forget, leaked handles, the ptt.rs global hook); ` +
      `partial teardown when an error interrupts the happy path halfway.`,
  },
  {
    key: 'state-desync',
    prompt:
      `Bug class: two sources of truth drifting - sweep the whole repo for THIS CLASS ONLY.\n` +
      `Pairs to audit: hub client maps vs pubsub registrations; server voice state vs LiveKit vs client ` +
      `stores; client read-state vs server acked sequence numbers; DB rows vs in-memory caches; ` +
      `any two structures updated by different code paths. Find the path that updates one and not the ` +
      `other - reconnect, replacement, and error paths are where they diverge.`,
  },
  {
    key: 'error-paths',
    prompt:
      `Bug class: error-path data loss - sweep the whole repo for THIS CLASS ONLY.\n` +
      `Swallowed errors (err assigned and ignored, empty catch, unwrap_or(default) hiding failure); ` +
      `partial writes left behind on early return; fallbacks that silently degrade to wrong behavior; ` +
      `an error mapped to success upstream; cleanup skipped when the happy path is interrupted mid-way. ` +
      `Read every 'if err != nil', catch block, and .catch in the hot files from recon.`,
  },
  {
    key: 'ordering-boundary',
    prompt:
      `Bug class: ordering and boundaries - sweep the whole repo for THIS CLASS ONLY.\n` +
      `Off-by-one and fence-post errors; LIMIT/pagination silently truncating; sequence-number gaps, ` +
      `duplication, or inversion between assignment and delivery; sort-stability and tie assumptions; ` +
      `first/last/empty-collection special cases; inclusive-vs-exclusive range disagreements between a ` +
      `caller and its callee (read the SQL alongside its Go caller).`,
  },
]

const FLOW_LENSES = [
  {
    key: 'flow-reconnect',
    prompt:
      `Flow: WebSocket drop -> reconnect -> resume. Trace it END TO END across all three languages before ` +
      `reporting anything. Server: the serve handshake/resume path, hub client replacement and state ` +
      `transfer (this transfer has needed four separate fixes: unsubscribe identity, VoiceTopic+E2EE key ` +
      `transfer, focused-channel transfer, closeSend ordering - hunt for what it STILL misses), topic ` +
      `re-subscription, cold/warm replay tiers. Client: the reconnect loop, seq ack tracking, store ` +
      `reconcile after resume. Report any state that exists on the old connection and does not provably ` +
      `reach the new one.`,
  },
  {
    key: 'flow-voice',
    prompt:
      `Flow: voice join -> E2EE key announce/offer -> key-holder election -> rotation -> participant ` +
      `leave -> LiveKit webhook -> cleanup. Trace it END TO END: Server/ws/*voice*, livekit_webhook.go, ` +
      `client livekitE2EE.ts and livekitSession.ts, Rust livekit_proxy.rs. Hunt for: a participant who can ` +
      `still decrypt after they should be excluded; holder-election stalls; epoch/key disagreement after ` +
      `reconnect; the three take-out-of-voice paths (webhook, sweep, voice_leave) diverging.`,
  },
  {
    key: 'flow-message',
    prompt:
      `Flow: message send -> permission gate -> persist -> sequence assign -> fan-out -> replay tiers -> ` +
      `client store -> read-state/unread counts. Trace it END TO END and hunt the gaps BETWEEN layers: ` +
      `persisted but never fanned out; delivered but sequence-skipped; acked via max(seq) while a lower ` +
      `seq was dropped; unread counts drifting from actual unread messages across reconnect or channel switch.`,
  },
  {
    key: 'flow-session',
    prompt:
      `Flow: login -> session/token issue -> per-connection auth -> revocation/sweep -> kick -> API-token ` +
      `paths. Trace it END TO END and hunt stale-authorization windows: state checked at connect but not ` +
      `re-checked at use; revocation that kicks the WS but leaves another surface authorized; the sweep ` +
      `racing an in-flight request; API tokens diverging from session-token semantics on any path.`,
  },
]

let riskySweepDone = false
function riskySweepLenses() {
  if (riskySweepDone || !HAS_INVENTORY || !RISKY_FILES.length || uncoveredCount() > 0) return null
  riskySweepDone = true // consumed even if this round's finders die: same at-most-once semantics as cooldown
  const list = RISKY_FILES.map((f) => `  - ${f}`).join('\n')
  return BUGCLASS_LENSES.map((l) => ({
    key: `risky-${l.key}`,
    prompt: `${l.prompt}\n\nScope this sweep to ONLY these highest-risk files (read each one in full):\n${list}`,
  }))
}
let currentFamilyName = 'surfaces'
function lensesForRound(round) {
  const pick = (name, lenses) => { currentFamilyName = name; return lenses }
  if (CUSTOM_LENSES) {
    if (round === 1) return pick('custom', CUSTOM_LENSES)
  } else {
    if (round === 1) return pick('surfaces', SURFACE_LENSES)
    if (round === 2) return pick('bug-classes', BUGCLASS_LENSES)
    if (round === 3) return pick('flows', FLOW_LENSES)
  }
  const risky = riskySweepLenses()
  if (risky) return pick('risky-sweep', risky)
  return pick('adaptive', buildAdaptiveLenses(round))
}
function familyName() { return currentFamilyName }
// Directory granularity: the old two/three-segment cluster collapsed the whole TS client into
// one bucket (35 of 82 findings), so the "top cluster" never changed for five straight rounds.
function clusterOf(file) {
  const parts = String(file).split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0]
}

// ---------- explore targeting ----------
// args.graph: session-computed coupling ranking (rank-explore.mjs). The workflow only reads
// .file - scoring already happened outside, where the filesystem is.
const GRAPH_ROWS = (Array.isArray(ARGS.graph) ? ARGS.graph : []).filter((r) => r && typeof r.file === 'string')
// ---------- coverage mode (spec 2026-08-20) ----------
// Arms only when rows carry the `examined` flag (full inventory from rank-explore.mjs).
// Legacy rows and the churn fallback leave all of this inert: covered stays empty,
// uncoveredCount() is 0, and the loop condition reduces to the old dry-threshold rule.
const HAS_INVENTORY = GRAPH_ROWS.some((r) => 'examined' in r)
const INVENTORY = HAS_INVENTORY ? GRAPH_ROWS.map((r) => r.file) : []
const covered = new Set(HAS_INVENTORY ? GRAPH_ROWS.filter((r) => r.examined).map((r) => r.file) : [])
const PRE_COVERED = covered.size
const RISKY_FILES = HAS_INVENTORY ? GRAPH_ROWS.filter((r) => r.risky).map((r) => r.file) : []
const uncoveredCount = () => (HAS_INVENTORY ? INVENTORY.reduce((n, f) => n + (covered.has(f) ? 0 : 1), 0) : 0)
if (HAS_INVENTORY) log(`coverage: inventory=${INVENTORY.length} preCovered=${PRE_COVERED} risky=${RISKY_FILES.length}`)
const EXPLORE_FILES_PER_LENS = 10
const exploreConsumed = new Set() // within-run consumption: never re-offer a file to a later round
let exploreFallbackLogged = false
function drawExploreFiles() {
  let pool
  if (GRAPH_ROWS.length) pool = GRAPH_ROWS.map((r) => r.file)
  else {
    if (!exploreFallbackLogged) {
      log('explore: args.graph absent/empty - falling back to churn-based fresh eyes')
      exploreFallbackLogged = true
    }
    pool = churnFiles
  }
  const avail = pool.filter((f) => !exploreConsumed.has(f) && !covered.has(f) && !seen.some((s) => s.file === f))
  const files = []
  while (files.length < EXPLORE_FILES_PER_LENS && avail.length) {
    const head = avail.shift()
    files.push(head)
    const dir = clusterOf(head)
    // pull same-directory siblings forward: one lens reading one module beats ten strangers
    for (let i = 0; i < avail.length && files.length < EXPLORE_FILES_PER_LENS; ) {
      if (clusterOf(avail[i]) === dir) files.push(avail.splice(i, 1)[0])
      else i++
    }
  }
  for (const f of files) exploreConsumed.add(f)
  return files
}
function exploreLens(i) {
  const files = drawExploreFiles()
  if (!files.length) return null
  const src = GRAPH_ROWS.length
    ? `These files are heavily coupled (per the code graph) to files where confirmed bugs live, yet no ` +
      `hunt has confirmed or refuted a single finding in them - either they are clean or every lens so ` +
      `far walked past them.`
    : `These files churned heavily in the last 8 weeks, yet no hunt round has confirmed or refuted a ` +
      `single finding in them - either they are clean or every lens so far walked past them.`
  return {
    key: `explore-${i}`,
    prompt: `${src} Read each one IN FULL with fresh eyes. Hunt every class: concurrency and ` +
      `interleaving (races, TOCTOU, lock ordering, stale-closure writes after await); lifecycle and ` +
      `teardown (unreleased acquires, use-after-close, missing disposal on error paths); state desync ` +
      `(two sources of truth updated by different code paths); error-path data loss (swallowed errors, ` +
      `partial writes, silent fallbacks); ordering and boundaries (off-by-one, pagination truncation, ` +
      `sequence gaps, inclusive/exclusive disagreements).\n` +
      files.map((f) => `  - ${f}`).join('\n'),
    files,
  }
}

let cooldownCluster = null // the top-ranked cluster hunted in round N sits out round N+1
function buildAdaptiveLenses(round) {
  const byCluster = {}
  for (const c of confirmedAll) {
    const cl = clusterOf(c.file)
    if (!byCluster[cl]) byCluster[cl] = []
    byCluster[cl].push(c)
  }
  // Explore-heavy schedule: measured hotspot yield flattened to 0.25 high+med/agent by round 6.
  const sweeping = uncoveredCount() > 0
  const hotspotQuota = round <= 5 ? 2 : 1
  // sweep pace: 4 explore lenses x 10 files while inventory files remain uncovered
  const exploreQuota = sweeping ? 4 : round <= 5 ? 2 : 3
  const hotKey = (cl) => ('hotspot ' + cl).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const picked = Object.entries(byCluster)
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([cl]) => cl !== cooldownCluster)
    .filter(([cl]) => (cleanStreak[hotKey(cl)] || 0) < 2) // pre-filter so backfill sees the real shortfall
    .slice(0, hotspotQuota)
  cooldownCluster = picked.length ? picked[0][0] : null
  const hotspots = picked.map(([cluster, items]) => ({
    key: hotKey(cluster),
    prompt:
      `Bugs cluster. Confirmed findings so far in ${cluster}:\n` +
      items.map((i) => `  - ${i.file}:${i.line} ${i.title}`).join('\n') +
      `\nHunt ADJACENT to these: the same functions' siblings, every caller, the counterpart operations ` +
      `(subscribe/unsubscribe, open/close, register/transfer, acquire/release), and the paths a past fix ` +
      `here did NOT cover. Do not re-report the findings listed above - they are already known.`,
  }))
  const shortfall = hotspotQuota - hotspots.length
  if (shortfall > 0) log(`adaptive: hotspot pool short by ${shortfall} - trying explore backfill`)
  const explores = []
  for (let i = 1; i <= exploreQuota + shortfall; i++) {
    if (!sweeping && (cleanStreak[`explore-${i}`] || 0) >= 2) continue // demoted slot: no substitution, that IS demotion
    const lens = exploreLens(i)
    if (!lens) {
      log(`adaptive: explore pool exhausted after ${explores.length} lens(es)`)
      break
    }
    explores.push(lens)
  }
  return [...hotspots, ...explores]
}

// ---------- dedupe + ledger helpers ----------
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2)
}
// Dedupe is permanent: a candidate merged into an existing entry never comes
// back, so an over-eager match silently loses a real bug rather than deferring
// it. The title-word branch therefore only applies near the prior's location -
// two distinct bugs in one file often share half their title words ("hub client
// map race on register" vs "...on unregister"), and without a window the second
// one is suppressed forever, sometimes by a merely REFUTED namesake.
const TITLE_MATCH_WINDOW = 60
function isDup(a, b) {
  if (a.file !== b.file) return false
  const delta = Math.abs((a.line || 0) - (b.line || 0))
  if (delta <= 10) return true
  if (delta > TITLE_MATCH_WINDOW) return false
  const aw = normTitle(a.title)
  if (!aw.length) return false
  const bw = new Set(normTitle(b.title))
  const hits = aw.filter((w) => bw.has(w)).length
  return hits * 2 >= aw.length
}
function dedupe(cands, priors, counts) {
  const kept = []
  for (const c of cands) {
    const prior = priors.find((p) => isDup(c, p))
    if (prior) {
      if (counts) counts[prior.fromLedger ? 'suppressedLedger' : 'suppressedRun']++
      continue
    }
    if (kept.some((k) => isDup(c, k))) {
      if (counts) counts.suppressedRun++
      continue
    }
    kept.push(c)
  }
  return kept
}
function seenBlock(seen) {
  if (!seen.length) return ''
  const lines = seen.map((s) => `  - ${s.file}:${s.line} [${s.status}] ${s.title}`)
  return `\n--- KNOWN FINDINGS (already investigated - do NOT re-report; refuted means examined and rejected) ---\n${lines.join('\n')}\n`
}
function convergenceTable(stats, converged, stoppedOnBudget) {
  const verdict = converged
    ? `CONVERGED after ${stats.length} round(s).`
    : stoppedOnBudget
      ? 'NOT converged - stopped on budget.'
      : 'NOT converged - hit the round backstop.'
  const rows = stats.map(
    (s) =>
      `| ${s.round} | ${s.family} | ${s.lenses} | ${s.candidates} | ${s.fresh} | ${s.confirmed} | ${s.refuted} | ${s.dryEligible ? 'yes' : 'NO'} | ${s.dryAfter} |`,
  )
  return [
    '## Convergence',
    '',
    verdict,
    '',
    '| round | family | lenses | candidates | fresh | confirmed | refuted | dry-eligible | dry after |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

// ---------- recon (verbatim from the current script, including both prompts) ----------
phase('Recon')
const recon = await parallel([
  () =>
    agent(
      `${RULES}\n\nRECON TASK (mechanical, do not hunt bugs yourself):\n` +
        `Run, from the repo root: git log --since="8 weeks ago" --name-only --pretty=format: -- Server Client\n` +
        `Count how often each non-test source file changed. Return the 25 most-churned files with their counts, ` +
        `plus any file that changed in more than 6 distinct commits. High churn = where bugs concentrate.\n` +
        `Return plain text: one "path  count" per line, most-churned first. No commentary.`,
      { label: 'recon:churn', phase: 'Recon', model: 'haiku', effort: 'xhigh' },
    ),
  () =>
    agent(
      `${RULES}\n\nRECON TASK (mechanical, do not hunt bugs yourself):\n` +
        `Inventory the concurrency and lifecycle surface so the finders know where to look. Report:\n` +
        `  (a) every Server/ non-test .go file containing "go func", "sync.", "chan ", "select {", or "context.WithCancel"\n` +
        `  (b) every Client/tauri-client/src/**/*.ts (non-test) containing "addEventListener", "setInterval", "setTimeout", or "new AbortController"\n` +
        `  (c) every Client/tauri-client/src-tauri/src/*.rs containing "unsafe", "Mutex", "RwLock", "spawn", or "unwrap()"\n` +
        `For each file give the path and a rough hit count. Return plain text grouped under (a)/(b)/(c). No commentary, no analysis.`,
      { label: 'recon:surface', phase: 'Recon', model: 'haiku', effort: 'xhigh' },
    ),
])
const CONTEXT = `\n\n--- RECON: most-churned files (last 8 weeks) ---\n${recon[0] || 'unavailable'}\n\n--- RECON: concurrency & lifecycle surface ---\n${recon[1] || 'unavailable'}\n`
const churnFiles = String(recon[0] || '')
  .split('\n')
  .map((l) => l.trim().split(/\s+/)[0])
  .filter((p) => p.includes('/'))
log('Recon complete - starting converging rounds')

// ---------- round loop ----------
// Cross-run memory: the calling session passes the findings ledger in as args.known.
// Seeding `seen` is all it takes - finderPrompt() already interpolates seenBlock(seen),
// and each round already dedupes fresh candidates against it, so one assignment buys both
// prompt-level suppression ("do not re-derive this") and mechanical dedupe.
const seen = (ARGS.known || []).map((k) => ({
  file: k.file,
  line: k.line,
  title: k.title,
  status: k.status || 'known',
  fromLedger: true, // telemetry: distinguishes ledger suppression from same-run suppression
}))
const confirmedAll = []
const unverified = []
const roundStats = []
const cleanStreak = {}
let dry = 0
let round = 0
let stoppedOnBudget = false
let coverageStall = 0
let stalledCoverage = false

function finderPrompt(lens, rnd) {
  return (
    `${RULES}${CONTEXT}${seenBlock(seen)}\n\nThis is round ${rnd} of a converging hunt. Everything under ` +
    `KNOWN FINDINGS has already been investigated - spend zero effort re-deriving those; hunt for what is ` +
    `NOT on that list.\n\n${lens.prompt}`
  )
}
function verifyPrompt(lensKey, candidates) {
  return (
    `${RULES}\n\nYou are an ADVERSARIAL VERIFIER. Another model hunted the "${lensKey}" lens of this repo and ` +
    `produced the candidate findings below. Your job is to REFUTE them, not to agree with them.\n\n` +
    `For each candidate, independently: open the cited file, read the surrounding function in full, grep every ` +
    `caller, and look for an existing test that locks the current behavior. Then ask, in order:\n` +
    `  1. Does the cited code actually say what the finding claims? (Misread code is the most common failure.)\n` +
    `  2. Is the bad state actually reachable, or does an upstream guard/type/lock make it impossible?\n` +
    `  3. Is the described repro real - can you name the concrete inputs or the exact interleaving?\n` +
    `  4. Is this intended behavior that a test already asserts?\n\n` +
    `Set refuted=true if ANY of those kills it. DEFAULT TO refuted=true when you are uncertain - a false ` +
    `positive costs more than a miss here. Only set refuted=false when you can point at the specific lines ` +
    `that prove the bug and describe how it fires.\n` +
    `Re-rate severity yourself; do not inherit the hunter's rating. For each survivor, give the smallest ` +
    `correct fix - one guard in the shared function beats a guard in every caller.\n\n` +
    `Return one verdict per candidate, keeping title/file/line so they can be matched up.\n\n` +
    // Strip the panel attribution here rather than at the call sites: the prompt above says
    // "another model" on purpose, and naming it is an authority cue that erodes refute-by-default.
    `--- CANDIDATES ---\n${JSON.stringify(candidates.map(({ finder, ...c }) => c), null, 2)}`
  )
}

const riskySweepPending = () => HAS_INVENTORY && RISKY_FILES.length > 0 && !riskySweepDone
while ((uncoveredCount() > 0 || riskySweepPending() || dry < DRY_THRESHOLD) && round < MAX_ROUNDS) {
  if (BUDGET_TOTAL && remainingBudget() < ROUND_BUDGET_FLOOR) {
    stoppedOnBudget = true
    log(`Budget floor reached (${Math.round(remainingBudget() / 1000)}k left) - stopping before round ${round + 1}`)
    break
  }
  const family = lensesForRound(round + 1)
  if (!family || !family.length) {
    // Coverage mode with the pool drained and the risky sweep done: an empty family means
    // hotspots are demoted/cooled and there is genuinely nothing left to hunt - that IS
    // quietness. Count it as a dry round so a late confirm cannot strand a fully-covered
    // run one dry round short of its earned convergence. Legacy mode keeps the hard stop:
    // an empty family there means "nothing targetable" (no churn, no graph), not "done".
    if (HAS_INVENTORY && uncoveredCount() === 0 && !riskySweepPending()) {
      round++
      dry++
      roundStats.push({ round, family: 'exhausted', lenses: 0, candidates: 0, fresh: 0, confirmed: 0, refuted: 0, dryEligible: true, dryAfter: dry, severity: { critical: 0, high: 0, medium: 0, low: 0 }, perLens: {}, filesTouched: 0, filesNew: 0, suppressedLedger: 0, suppressedRun: 0, finderNull: 0, finderEmpty: 0, verifierNull: 0, spentBefore: budget.spent(), spentAfter: budget.spent() })
      log(`Round ${round}: nothing left to hunt - counts as a dry round (dry=${dry})`)
      continue
    }
    break // nothing to hunt != everything demoted
  }
  round++
  const uncBefore = uncoveredCount()
  const spentBefore = budget.spent()
  const counts = { suppressedLedger: 0, suppressedRun: 0, finderNull: 0, finderEmpty: 0, verifierNull: 0 }
  const sweepingNow = uncoveredCount() > 0
  const lenses = family.filter((l) => (sweepingNow && /^explore-/.test(l.key)) || (cleanStreak[l.key] || 0) < 2)
  if (!lenses.length) {
    dry++
    roundStats.push({ round, family: familyName(round), lenses: 0, candidates: 0, fresh: 0, confirmed: 0, refuted: 0, dryEligible: true, dryAfter: dry, severity: { critical: 0, high: 0, medium: 0, low: 0 }, perLens: {}, filesTouched: 0, filesNew: 0, ...counts, spentBefore, spentAfter: budget.spent() })
    log(`Round ${round}: every lens demoted - counts as a dry round (dry=${dry})`)
    continue
  }
  const rnd = round
  const seenAtStart = seen.slice()
  const lensResults = await pipeline(
    lenses,
    (lens) =>
      agent(finderPrompt(lens, rnd), { label: `r${rnd}:hunt:${lens.key}:opus`, phase: `Round ${rnd}`, model: 'opus', effort: 'high', schema: FINDINGS })
        .then((res) => ({ lens, res })),
    async (r) => {
      const { lens, res } = r
      // agent() returns null on failure; a thrown stage instead nulls the whole lens result,
      // which the eligibility check catches separately. Both checks are needed.
      const finderFailed = res === null
      if (finderFailed) counts.finderNull++
      else if (!(res.findings || []).length) counts.finderEmpty++
      // finder is constant now; kept on the record for ledger continuity across hunts
      const union = res ? (res.findings || []).map((f) => ({ ...f, finder: 'opus' })) : []
      const fresh = dedupe(union, seenAtStart, counts)
      if (!fresh.length) return { lens, finderFailed, unionCount: union.length, fresh: [], matched: [], unmatched: [] }
      log(`r${rnd} ${lens.key}: ${fresh.length} fresh candidate(s) -> verification`)
      // opus, not fable: fable verify agents hit usage limits and nulled out en masse on
      // the 2026-08-13 live run (and were the dominant cost even when they worked)
      const vopts = { phase: `Round ${rnd}`, model: 'opus', effort: 'high', schema: VERDICTS }
      // Pair verdicts to candidates as they arrive, then retry ONLY what got no usable verdict.
      // Retrying the whole batch re-burned every verdict on a partial return, and the old
      // count-based trigger let N unmatched garbage verdicts skip the retry entirely.
      const matched = []
      const unmatched = fresh.slice()
      const absorb = (vs) => {
        for (const v of vs || []) {
          const vRec = { file: v.file, line: v.line, title: v.title }
          const idx = unmatched.findIndex((f) => isDup(vRec, f) || isDup(f, vRec))
          if (idx === -1) {
            const claimed = matched.some(({ cand }) => isDup(vRec, cand) || isDup(cand, vRec))
            log(`r${rnd} ${lens.key}: verifier verdict "${v.title}" (${v.file}:${v.line}) ${claimed ? 'duplicates an already-claimed candidate' : 'matched no candidate'} - dropped`)
            continue
          }
          const [cand] = unmatched.splice(idx, 1)
          matched.push({ v, cand })
        }
      }
      const v1 = await agent(verifyPrompt(lens.key, fresh), { ...vopts, label: `r${rnd}:verify:${lens.key}` })
      absorb(v1 && v1.verdicts)
      if (!v1) counts.verifierNull++
      if (unmatched.length) {
        const v2 = await agent(verifyPrompt(lens.key, unmatched.slice()), { ...vopts, label: `r${rnd}:verify:${lens.key}:retry` })
        absorb(v2 && v2.verdicts)
        if (!v2) counts.verifierNull++
      }
      return { lens, finderFailed, unionCount: union.length, fresh, matched, unmatched }
    },
  )

  // a thrown stage nulls the whole lens result - rewind its explore draw too, or the
  // session records never-read files as explored-clean (the same poison as a null finder)
  lensResults.forEach((r, i) => {
    if (!r && lenses[i].files) for (const f of lenses[i].files) exploreConsumed.delete(f)
  })

  let eligible = !lensResults.some((r) => !r)
  let newConfirmed = 0
  let newRefuted = 0
  let candCount = 0
  let freshCount = 0
  const perLens = {}
  const sevMix = { critical: 0, high: 0, medium: 0, low: 0 }
  const filesTouched = new Set()
  const filesNew = new Set()
  for (const r of lensResults.filter(Boolean)) {
    candCount += r.unionCount
    freshCount += r.fresh.length
    if (r.finderFailed) eligible = false
    if (r.lens.files) {
      // coverage credit (spec: only explicit-file lenses that ran to completion). A lens
      // denied credit - dead finder OR candidates left unverified - returns its whole draw
      // to the pool: consumed-but-uncovered files would otherwise strand uncoveredCount()
      // above zero forever, and a partially-verified draw is not evidence of cleanliness.
      if (!r.finderFailed && !r.unmatched.length) for (const f of r.lens.files) covered.add(f)
      else for (const f of r.lens.files) exploreConsumed.delete(f)
    }
    let lensConfirmed = 0
    let lensRefuted = 0
    for (const { v, cand } of r.matched) {
      // Keep the matched candidate: the verdict schema has no why/repro/evidence, and the
      // ledger needs them. Verdict fields are spread last so the verifier's re-rated severity
      // and its corrected title/file/line win over the finder's.
      const rec = { file: v.file, line: v.line, title: v.title, status: v.refuted ? 'refuted' : 'confirmed' }
      if (seen.some((p) => isDup(rec, p))) { counts.suppressedRun++; continue } // cross-lens same-round duplicate
      seen.push(rec)
      covered.add(rec.file) // any verdict proves the file was read (inert in legacy mode: seen already blocks re-draws)
      if (v.refuted) { newRefuted++; lensRefuted++ }
      else {
        newConfirmed++
        lensConfirmed++
        sevMix[v.severity] = (sevMix[v.severity] || 0) + 1
        confirmedAll.push({ ...cand, ...v, lens: r.lens.key, round })
      }
    }
    if (r.unmatched.length) {
      eligible = false // partial verifier failure: some candidates got no verdict at all
      for (const f of r.unmatched) unverified.push({ ...f, lens: r.lens.key, round })
    }
    // a lens hunted at partial panel strength, or whose candidates never got a verdict, is not evidence of cleanliness
    if (!r.finderFailed && !r.unmatched.length) cleanStreak[r.lens.key] = lensConfirmed > 0 ? 0 : (cleanStreak[r.lens.key] || 0) + 1
    perLens[r.lens.key] = { candidates: r.unionCount, fresh: r.fresh.length, confirmed: lensConfirmed, refuted: lensRefuted, unverified: r.unmatched.length }
    // coverage proxy: files that produced fresh candidates this round (finder reading is unobservable)
    for (const f of r.fresh) {
      filesTouched.add(f.file)
      if (!seenAtStart.some((s) => s.file === f.file)) filesNew.add(f.file)
    }
  }

  if (newConfirmed > 0) dry = 0
  else if (eligible) dry++
  // ineligible zero-confirm round: dry unchanged - "we didn't fully look" is not "it's clean"
  roundStats.push({ round, family: familyName(round), lenses: lenses.length, candidates: candCount, fresh: freshCount, confirmed: newConfirmed, refuted: newRefuted, dryEligible: eligible, dryAfter: dry, severity: sevMix, perLens, filesTouched: filesTouched.size, filesNew: filesNew.size, ...counts, spentBefore, spentAfter: budget.spent() })
  log(`Round ${round} (${familyName(round)}): ${newConfirmed} confirmed, ${newRefuted} refuted, dry=${dry}${eligible ? '' : ' (ineligible)'}`)

  // stalled coverage: an adaptive round that failed to shrink a non-empty uncovered pool.
  // Only adaptive rounds count - rounds 1-3 never draw explore files by design.
  const uncAfter = uncoveredCount()
  if (HAS_INVENTORY && familyName() === 'adaptive' && uncAfter > 0) {
    coverageStall = uncAfter < uncBefore ? 0 : coverageStall + 1
    if (coverageStall >= 2) {
      stalledCoverage = true
      log(`Coverage stalled: uncovered=${uncAfter} did not shrink for 2 adaptive rounds - stopping`)
      break
    }
  } else coverageStall = 0
}

const converged = uncoveredCount() === 0 && !riskySweepPending() && dry >= DRY_THRESHOLD

// ---------- report (deterministic) ----------
// A report agent silently dropped findings (79 sections for 82 confirmed on 2026-08-12), so the
// markdown is assembled in-script from confirmedSorted. Coordinate spot-checking moved to the
// calling session, which validates EVERY finding's file/line after return (see bughunt-run).
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const confirmedSorted = confirmedAll.slice().sort((a, b) => RANK[a.severity] - RANK[b.severity])
const unverifiedFinal = unverified.filter((u) => !seen.some((p) => isDup(u, p)))
const table = convergenceTable(roundStats, converged, stoppedOnBudget)
const sum = (k) => roundStats.reduce((n, r) => n + (r[k] || 0), 0)
const runStats = {
  config: { maxRounds: MAX_ROUNDS, dryThreshold: DRY_THRESHOLD, customLenses: !!CUSTOM_LENSES, knownCount: (ARGS.known || []).length, graphRows: GRAPH_ROWS.length, budgetTotal: BUDGET_TOTAL },
  coverage: HAS_INVENTORY ? { inventory: INVENTORY.length, preCovered: PRE_COVERED, covered: INVENTORY.length - uncoveredCount(), uncoveredAtStop: uncoveredCount() } : null,
  spentTotal: budget.spent(),
  rounds: roundStats.length,
  converged,
  stoppedOnBudget,
  stalledCoverage,
  confirmed: confirmedSorted.length,
  refuted: sum('refuted'),
  unverified: unverifiedFinal.length,
  suppressedLedger: sum('suppressedLedger'),
  suppressedRun: sum('suppressedRun'),
  finderNull: sum('finderNull'),
  finderEmpty: sum('finderEmpty'),
  verifierNull: sum('verifierNull'),
}

function buildReport() {
  const outcome = converged
    ? `CONVERGED after ${round} round(s).`
    : stoppedOnBudget
      ? `NOT converged - stopped on budget after ${round} round(s).`
      : `NOT converged - hit the round backstop after ${round} round(s).`
  const sev = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of confirmedSorted) sev[f.severity] = (sev[f.severity] || 0) + 1
  const lines = ['# Bug hunt report', '']
  lines.push(
    `${confirmedSorted.length} confirmed finding(s) - ${sev.critical} critical, ${sev.high} high, ` +
      `${sev.medium} medium, ${sev.low} low. ${outcome}` +
      (confirmedSorted.length
        ? ` Fix first: ${confirmedSorted[0].title} (\`${confirmedSorted[0].file}:${confirmedSorted[0].line}\`).`
        : ''),
    '',
  )
  for (const f of confirmedSorted) {
    lines.push(`### ${f.severity} - ${f.title}`, '')
    lines.push(`\`${f.file}:${f.line}\` - lens \`${f.lens}\`, round ${f.round}, confidence ${f.confidence}`, '')
    if (f.why) lines.push(f.why, '')
    if (f.repro) lines.push(`**Repro:** ${f.repro}`, '')
    if (f.evidence) lines.push(`**Evidence:** ${f.evidence}`, '')
    if (f.fix) lines.push(`**Fix:** ${f.fix}`, '')
  }
  if (unverifiedFinal.length) {
    lines.push('## Unverified - re-run', '')
    for (const u of unverifiedFinal) lines.push(`- \`${u.file}:${u.line}\` ${u.title} (lens \`${u.lens}\`, round ${u.round})`)
    lines.push('')
  }
  lines.push(table)
  lines.push('', '## Run stats', '')
  lines.push(
    `Total spent: ${runStats.spentTotal} output tokens across ${runStats.rounds} round(s). ` +
      `Suppressed by dedupe: ${runStats.suppressedLedger} ledger-known, ${runStats.suppressedRun} same-run. ` +
      `Agent failures: ${runStats.finderNull} finder null, ${runStats.finderEmpty} finder empty, ${runStats.verifierNull} verifier null.`,
    '',
  )
  lines.push('| round | spent | files (new) | suppressed ledger/run | finder null/empty | verifier null |')
  lines.push('|---|---|---|---|---|---|')
  for (const s of roundStats)
    lines.push(`| ${s.round} | ${s.spentAfter - s.spentBefore} | ${s.filesTouched} (${s.filesNew}) | ${s.suppressedLedger}/${s.suppressedRun} | ${s.finderNull}/${s.finderEmpty} | ${s.verifierNull} |`)
  return lines.join('\n')
}
const report = buildReport()

return { converged, stoppedOnBudget, stalledCoverage, rounds: roundStats, confirmed: confirmedSorted, unverified: unverifiedFinal, runStats, exploredFiles: [...exploreConsumed], report }
