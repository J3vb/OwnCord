export const meta = {
  name: 'bughunt',
  description: 'Converging multi-round bug hunt: rotating lens families, dual-model panels, fable refute-by-default verification, dry-threshold stop',
  whenToUse: 'Hunting real bugs across the Go server, Tauri Rust backend, and TS client until consecutive rounds go dry. Not a security-only scan.',
  phases: [
    { title: 'Recon', detail: 'haiku: churn + concurrency-surface inventory' },
    { title: 'Report', detail: 'fable: ranked findings + convergence table' },
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
const MAX_ROUNDS = ARGS.maxRounds || 8
const DRY_THRESHOLD = ARGS.dryThreshold || 2
// A scoped hunt (args.lenses) replaces the round-1 family outright; later rounds still go
// adaptive, so hotspot and fresh-eyes coverage - and therefore convergence - still work.
const CUSTOM_LENSES = Array.isArray(ARGS.lenses) && ARGS.lenses.length ? ARGS.lenses : null
// ponytail: rough floor for one round (up to 12 high-effort finders + verifiers); tune after live runs
const ROUND_BUDGET_FLOOR = 150000
// The args channel has already been observed delivering something the script
// could not read; an unnoticed fallback here is an 8x cost surprise, so say out
// loud what the run is actually going to do.
log(`config: maxRounds=${MAX_ROUNDS} dryThreshold=${DRY_THRESHOLD}${CUSTOM_LENSES ? ` lenses=custom(${CUSTOM_LENSES.length})` : ''}`)

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
Repo: OwnCord, at D:/Local-Lab/Repos/OwnCord. Go 1.26 server in Server/, Tauri v2 client in Client/tauri-client/
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
  1. Read the actual files. Never report from a filename or a grep hit alone.
  2. For every candidate, grep for ALL callers before judging - a guard may already live upstream.
  3. Check whether an existing test already locks the behavior you think is wrong. If a test asserts it,
     it is intended behavior, not a bug. Test files are *_test.go and tests/unit/*.test.ts.
  4. Report EVERY finding you can prove - there is no cap. The quality bar stays: zero findings is a
     valid, respectable answer, and each finding needs file, line, and a concrete repro.

You may run read-only shell commands (grep, git log, go doc). Do not modify any file. Do not run the test suite.
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

function lensesForRound(round) {
  if (CUSTOM_LENSES) return round === 1 ? CUSTOM_LENSES : buildAdaptiveLenses()
  if (round === 1) return SURFACE_LENSES
  if (round === 2) return BUGCLASS_LENSES
  if (round === 3) return FLOW_LENSES
  return buildAdaptiveLenses()
}
function familyName(round) {
  if (CUSTOM_LENSES) return round === 1 ? 'custom' : 'adaptive'
  return ['surfaces', 'bug-classes', 'flows'][round - 1] || 'adaptive'
}
function clusterOf(file) {
  const parts = String(file).split('/')
  return parts.slice(0, parts[0] === 'Client' ? 3 : 2).join('/')
}
function freshEyesLens() {
  const files = churnFiles.filter((f) => !seen.some((s) => s.file === f)).slice(0, 10)
  if (!files.length) return []
  return [
    {
      key: 'fresh-eyes',
      prompt:
        `These files churned heavily in the last 8 weeks, yet no hunt round has confirmed or refuted a ` +
        `single finding in them - either they are clean or every lens so far walked past them. Read each ` +
        `one IN FULL with fresh eyes and hunt for real bugs of any class:\n` +
        files.map((f) => `  - ${f}`).join('\n'),
    },
  ]
}
function buildAdaptiveLenses() {
  const byCluster = {}
  for (const c of confirmedAll) {
    const cl = clusterOf(c.file)
    if (!byCluster[cl]) byCluster[cl] = []
    byCluster[cl].push(c)
  }
  const top = Object.entries(byCluster)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
  const hotspots = top.map(([cluster, items]) => ({
    key: ('hotspot ' + cluster).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    prompt:
      `Bugs cluster. Confirmed findings so far in ${cluster}:\n` +
      items.map((i) => `  - ${i.file}:${i.line} ${i.title}`).join('\n') +
      `\nHunt ADJACENT to these: the same functions' siblings, every caller, the counterpart operations ` +
      `(subscribe/unsubscribe, open/close, register/transfer, acquire/release), and the paths a past fix ` +
      `here did NOT cover. Do not re-report the findings listed above - they are already known.`,
  }))
  return [...hotspots, ...freshEyesLens()]
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
function dedupe(cands, priors) {
  const kept = []
  for (const c of cands) {
    if (priors.some((p) => isDup(c, p)) || kept.some((k) => isDup(c, k))) continue
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
        `Run: git -C D:/Local-Lab/Repos/OwnCord log --since="8 weeks ago" --name-only --pretty=format: -- Server Client\n` +
        `Count how often each non-test source file changed. Return the 25 most-churned files with their counts, ` +
        `plus any file that changed in more than 6 distinct commits. High churn = where bugs concentrate.\n` +
        `Return plain text: one "path  count" per line, most-churned first. No commentary.`,
      { label: 'recon:churn', phase: 'Recon', model: 'haiku', effort: 'low' },
    ),
  () =>
    agent(
      `${RULES}\n\nRECON TASK (mechanical, do not hunt bugs yourself):\n` +
        `Inventory the concurrency and lifecycle surface so the finders know where to look. Report:\n` +
        `  (a) every Server/ non-test .go file containing "go func", "sync.", "chan ", "select {", or "context.WithCancel"\n` +
        `  (b) every Client/tauri-client/src/**/*.ts (non-test) containing "addEventListener", "setInterval", "setTimeout", or "new AbortController"\n` +
        `  (c) every Client/tauri-client/src-tauri/src/*.rs containing "unsafe", "Mutex", "RwLock", "spawn", or "unwrap()"\n` +
        `For each file give the path and a rough hit count. Return plain text grouped under (a)/(b)/(c). No commentary, no analysis.`,
      { label: 'recon:surface', phase: 'Recon', model: 'haiku', effort: 'low' },
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
}))
const confirmedAll = []
const unverified = []
const roundStats = []
const cleanStreak = {}
let dry = 0
let round = 0
let stoppedOnBudget = false

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
    `--- CANDIDATES ---\n${JSON.stringify(candidates, null, 2)}`
  )
}

while (dry < DRY_THRESHOLD && round < MAX_ROUNDS) {
  if (budget.total && budget.remaining() < ROUND_BUDGET_FLOOR) {
    stoppedOnBudget = true
    log(`Budget floor reached (${Math.round(budget.remaining() / 1000)}k left) - stopping before round ${round + 1}`)
    break
  }
  const family = lensesForRound(round + 1)
  if (!family || !family.length) break // nothing to hunt != everything demoted
  round++
  const lenses = family.filter((l) => (cleanStreak[l.key] || 0) < 2)
  if (!lenses.length) {
    dry++
    roundStats.push({ round, family: familyName(round), lenses: 0, candidates: 0, fresh: 0, confirmed: 0, refuted: 0, dryEligible: true, dryAfter: dry })
    log(`Round ${round}: every lens demoted - counts as a dry round (dry=${dry})`)
    continue
  }
  const rnd = round
  const seenAtStart = seen.slice()
  const lensResults = await pipeline(
    lenses,
    (lens) =>
      parallel([
        () => agent(finderPrompt(lens, rnd), { label: `r${rnd}:hunt:${lens.key}:opus`, phase: `Round ${rnd}`, model: 'opus', effort: 'high', schema: FINDINGS }),
        () => agent(finderPrompt(lens, rnd), { label: `r${rnd}:hunt:${lens.key}:sonnet`, phase: `Round ${rnd}`, model: 'sonnet', effort: 'high', schema: FINDINGS }),
      ]).then((pair) => ({ lens, pair })),
    async (r) => {
      const { lens, pair } = r
      const finderFailed = pair.some((p) => p === null)
      const union = pair.filter(Boolean).flatMap((p) => p.findings || [])
      const fresh = dedupe(union, seenAtStart)
      if (!fresh.length) return { lens, finderFailed, unionCount: union.length, fresh: [], verdicts: [] }
      log(`r${rnd} ${lens.key}: ${fresh.length} fresh candidate(s) -> verification`)
      const vopts = { phase: `Round ${rnd}`, model: 'fable', effort: 'high', schema: VERDICTS }
      let v = await agent(verifyPrompt(lens.key, fresh), { ...vopts, label: `r${rnd}:verify:${lens.key}` })
      if (!v || (v.verdicts || []).length < fresh.length) {
        const retry = await agent(verifyPrompt(lens.key, fresh), { ...vopts, label: `r${rnd}:verify:${lens.key}:retry` })
        if (((retry && retry.verdicts) || []).length > ((v && v.verdicts) || []).length) v = retry
      }
      return { lens, finderFailed, unionCount: union.length, fresh, verdicts: (v && v.verdicts) || [] }
    },
  )

  let eligible = !lensResults.some((r) => !r)
  let newConfirmed = 0
  let newRefuted = 0
  let candCount = 0
  let freshCount = 0
  for (const r of lensResults.filter(Boolean)) {
    candCount += r.unionCount
    freshCount += r.fresh.length
    if (r.finderFailed) eligible = false
    let lensConfirmed = 0
    const unmatched = r.fresh.slice()
    for (const v of r.verdicts) {
      const vRec = { file: v.file, line: v.line, title: v.title }
      const idx = unmatched.findIndex((f) => isDup(vRec, f) || isDup(f, vRec))
      if (idx === -1) {
        log(`r${round} ${r.lens.key}: verifier verdict "${v.title}" (${v.file}:${v.line}) matched no candidate - dropped`)
        continue
      }
      unmatched.splice(idx, 1)
      const rec = { file: v.file, line: v.line, title: v.title, status: v.refuted ? 'refuted' : 'confirmed' }
      if (seen.some((p) => isDup(rec, p))) continue // cross-lens same-round duplicate
      seen.push(rec)
      if (v.refuted) newRefuted++
      else {
        newConfirmed++
        lensConfirmed++
        confirmedAll.push({ ...v, lens: r.lens.key, round })
      }
    }
    if (unmatched.length) {
      eligible = false // partial verifier failure: some candidates got no verdict at all
      for (const f of unmatched) unverified.push({ ...f, lens: r.lens.key, round })
    }
    // a lens hunted at partial panel strength, or whose candidates never got a verdict, is not evidence of cleanliness
    if (!r.finderFailed && !unmatched.length) cleanStreak[r.lens.key] = lensConfirmed > 0 ? 0 : (cleanStreak[r.lens.key] || 0) + 1
  }

  if (newConfirmed > 0) dry = 0
  else if (eligible) dry++
  // ineligible zero-confirm round: dry unchanged - "we didn't fully look" is not "it's clean"
  roundStats.push({ round, family: familyName(round), lenses: lenses.length, candidates: candCount, fresh: freshCount, confirmed: newConfirmed, refuted: newRefuted, dryEligible: eligible, dryAfter: dry })
  log(`Round ${round} (${familyName(round)}): ${newConfirmed} confirmed, ${newRefuted} refuted, dry=${dry}${eligible ? '' : ' (ineligible)'}`)
}

const converged = dry >= DRY_THRESHOLD

// ---------- report ----------
phase('Report')
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const confirmedSorted = confirmedAll.slice().sort((a, b) => RANK[a.severity] - RANK[b.severity])
const unverifiedFinal = unverified.filter((u) => !seen.some((p) => isDup(u, p)))
const table = convergenceTable(roundStats, converged, stoppedOnBudget)

let report
if (!confirmedSorted.length && !unverifiedFinal.length) {
  const outcome = converged ? 'Converged' : stoppedOnBudget ? 'Stopped on budget - NOT converged' : 'Hit the round backstop - NOT converged'
  report = `${outcome} after ${round} round(s) with zero confirmed findings.\n\n${table}`
} else {
  report = await agent(
    `You are writing the final bug-hunt report for OwnCord (D:/Local-Lab/Repos/OwnCord).\n\n` +
      `The findings below already survived adversarial verification - do NOT re-litigate them, and do NOT add new ` +
      `ones. Your job is presentation and prioritization for a maintainer who will fix these today.\n\n` +
      `Spot-check the two highest-severity findings against the real files to make sure file paths and line numbers ` +
      `are accurate; correct them silently if they drifted.\n\n` +
      `Write markdown:\n` +
      `  - Open with one paragraph: how many real bugs, in which subsystems, whether the hunt CONVERGED, and which ` +
      `finding to fix first and why.\n` +
      `  - Then one section per finding, ordered by severity: a "### <severity> - <title>" heading, the ` +
      `\`file:line\` reference, what breaks and under exactly what conditions, and the smallest correct fix.\n` +
      (unverifiedFinal.length
        ? `  - Then an "## Unverified - re-run" section listing these candidates whose verification failed twice: ` +
          `${JSON.stringify(unverifiedFinal)}\n`
        : '') +
      `  - End with the convergence table below, VERBATIM.\n` +
      `Write in complete sentences. No emoji, no "consider" hedging.\n\n` +
      `--- CONFIRMED FINDINGS ---\n${JSON.stringify(confirmedSorted, null, 2)}\n\n` +
      `--- CONVERGENCE TABLE ---\n${table}`,
    { label: 'report', phase: 'Report', model: 'fable', effort: 'high' },
  )
}

return { converged, stoppedOnBudget, rounds: roundStats, confirmed: confirmedSorted, unverified: unverifiedFinal, report }
