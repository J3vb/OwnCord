# Plan: B6-6 — Direct port-forward operation and honest limits

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-6 — Direct port-forward operation and honest limits (roadmap workstream 4)
**Backing requirements**: BPR-013 (a reverse proxy must not be required), BPR-014 (domain names and raw public IPs are both supported connection addresses)
**Complexity**: Medium
**Drafted**: 2026-09-11 at `dev` `6a7077fc`

## Summary

Half of this milestone is already true and nobody wrote it down: OwnCord
terminates its own TLS, mounts LiveKit signalling under its own port, and
`docs/deployment.md:330-332` already says a reverse proxy is not required. The
other half is not true, and it fails in the exact way the milestone names.

**The server tells the operator a LAN-only address is "an address this machine
can be reached at", at every single start.** `getOutboundIP`
(`Server/internal/app/banner.go:95-123`) picks the first `IsGlobalUnicast` IPv4
on any interface, and Go's `IsGlobalUnicast` is **true for RFC1918** (measured,
below). On a home server the banner prints
`API https://192.168.1.50:8443/api/v1/info` with no qualifier; on a Docker host
it can print the bridge address `172.17.0.1`. The owner shares that URL, and it
works for them and nobody else. That is a network limit disguised as
application success, printed in the one place every owner looks.

So B6-6 is **not** documentation-only, and it is **not** a new endpoint either.
It is four honesty fixes in code, one documentation rewrite, and a pinned
refusal:

1. The banner names what kind of address it printed, and ranks a public address
   above a private one when the host has both.
2. `isPrivateIP` (`Server/api/diagnostics_handler.go:87-99`) is a string-prefix
   classifier that cannot see `100.64.0.0/10`. CGNAT is this milestone's own
   subject, and the one classifier we ship is blind to it.
3. The admin-gated diagnostics endpoint gains a `reachability` block — behind
   `server.reachability_report_enabled`, default off (owner decision 3): the
   facts that are determinable from inside the NAT, plus an **explicit list of
   the facts that are not**, each with the check the owner runs instead.
4. ACME certificate-issuance failures are currently discarded entirely
   (`Server/internal/app/lifecycle.go:377` sets `ErrorLog` to `io.Discard`), so
   a server whose port 80 is unreachable logs "server starting" and looks
   healthy while every handshake fails. One log line fixes that.
5. `docs/port-forwarding.md` (48 lines, zero mentions of CGNAT or hairpin NAT)
   is rewritten, and states plainly which paths this build leaves unqualified.

**No new route, no new outbound dependency, no schema change, no certificate
work.** The TLS block (B6-3 – B6-5) is deferred by owner decision 2026-09-11;
nothing here issues, requests or plans a certificate for a public IP.

### The uncomfortable finding, stated up front

**A server cannot detect CGNAT or hairpin NAT from the inside, and this plan
does not pretend otherwise.** A host behind a home router sees only its own LAN
address; the router's WAN address — the thing that would reveal carrier NAT —
is invisible to it. Hairpin NAT is a property of the router's forwarding
behaviour for a public address the server does not know. ISP port blocking,
inbound firewall state and dynamic-IP churn are all equally invisible.

The only local CGNAT signal that exists is a `100.64.0.0/10` address on a local
interface, and **that signal is confounded**: `docs/tailscale.md:19-24` already
documents that Tailscale hands out `100.x.y.z` addresses from exactly that
range. So the report **observes the address and names both explanations**; it
never concludes "you are behind CGNAT". Reporting "I cannot determine this from
here, and here is how you check it yourself" is the deliverable, and Task 3's
`undeterminable` list is where it lives.

## Owner decisions (2026-09-11)

All four open questions answered. Three took the plan's recommendation; the
third narrowed scope, and the narrowing is recorded here rather than silently
absorbed.

1. **The honesty line goes in the banner.** One qualifier line in the ASCII
   banner itself, varying by address class. Task 2 as written.
2. **`Server/auth/tls.go` may be touched: both 6a and 6b.** The issuance-failure
   log wrapper and the corrected IP-rejection string both land in this
   milestone. Neither carries certificate logic for B6-3 to unpick.
3. **The `reachability` block ships behind a config flag, default off.**
   `server.reachability_report_enabled`, zero-value false, no `defaults()`
   entry — the `browser_client_enabled` shape exactly. When it is off the
   `reachability` key is **absent** from the response, not present-and-empty.
4. **BPR-014 is recorded as blocked on B6-3**, not as partially satisfied here.
   `docs/plans/beta-requirements-traceability-2026-08-23.md` gets that row.

### What decision 3 changes, and the one line it does not

The flag is a second gate on a surface that already carries the strictest gate
in the repo (`AuthMiddleware` + `RequirePermission(Administrator)` + 5/min rate
limit, `Server/api/router.go:207-210`). That is defensible: the block
enumerates every local interface address, which is the most topology-revealing
thing this server would emit, and H-8 restricted the endpoint in the first
place _because_ it reveals topology.

The cost is that a report nobody enables is a report nobody reads, and this
milestone's outcome is that limits are **reported**, not merely reportable. So
the flag is scoped as narrowly as it can be:

- **Gated (default off):** the `reachability` block on the diagnostics endpoint
  — local address enumeration, port inventory, the `undeterminable` list.
- **Never gated:** the banner qualifier (Task 2) and the `warnOnServerConfig`
  warnings (Task 6c). Those always print, for every owner, on every start.

That keeps the honest answer universal at boot while making the detailed
interface dump an opt-in. `TestReachabilityBannerIsNotGatedByTheFlag` pins the
split so a later edit cannot quietly move the banner behind the flag.

## Verify before you implement

Facts established from source at `6a7077fc`; re-check any a parallel branch may
have moved. Refuted rows are the ones that changed the shape of this plan.

| Claim                                                                              | Status        | Evidence                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/diagnostics/connectivity` exists and is admin-gated                   | **Confirmed** | `Server/api/router.go:207-210`; `AuthMiddleware` + `RequirePermission(permissions.Administrator)` + `RateLimitMiddleware(…, 5, time.Minute)`                                                                 |
| It reports server, voice and LiveKit health today                                  | **Confirmed** | `Server/api/diagnostics_handler.go:13-37` — `serverDiag`, `voiceDiag`, `clientDiag`; no network/reachability block                                                                                           |
| The route is at `router.go:209`                                                    | **Confirmed** | `Server/api/router.go:209` is the `Get(` line; the `r.With(` chain opens at `:207`                                                                                                                           |
| `docs/port-forwarding.md` is 48 lines and never mentions CGNAT or hairpin NAT      | **Confirmed** | `wc -l` = 48; repo-wide grep finds "hairpin" in **no** file at all, and "CGNAT" only in `docs/tailscale.md:8,21,45`, `Server/safefetch/classify.go:30` and planning docs                                     |
| `docs/tailscale.md` is the documented alternative to manual forwarding             | **Confirmed** | `docs/port-forwarding.md:7` links it as "a simpler remote-access path"; `docs/tailscale.md:1-8`                                                                                                              |
| LiveKit needs 7880/TCP, 7881/TCP and 50000-60000/UDP                               | **Confirmed** | Generated `livekit.yaml`: `port: 7880`, `port_range_start: 50000`, `port_range_end: 60000` (`Server/ws/livekit_process.go:130-136`); 7881 in `docs/deployment.md:571-573`                                    |
| **`getOutboundIP` presents a private LAN address as the server's address**         | **Confirmed** | `Server/internal/app/banner.go:95-123`; its own doc comment says "an address this machine can be reached at". Printed unqualified at `banner.go:47-50`                                                       |
| **Go's `IsGlobalUnicast` is true for RFC1918, so that pick is a LAN address**      | **Confirmed** | Measured: `192.168.1.50 IsGlobalUnicast=true`, `10.0.0.5 true`, `100.64.1.2 true`, `fd12::1 true`. Only loopback/link-local/multicast/unspecified are excluded                                               |
| **`netip.Addr.IsPrivate` does NOT cover `100.64.0.0/10`**                          | **Confirmed** | Measured: `100.64.1.2 netip.IsPrivate=false`. CGNAT needs an explicit prefix, exactly as `Server/safefetch/classify.go:30` does it                                                                           |
| **`isPrivateIP` cannot see CGNAT, IPv4 link-local, IPv6 link-local, or mapped v4** | **Confirmed** | `Server/api/diagnostics_handler.go:87-99` — a string-prefix list with no `100.64`, no `169.254.`, no `fe80`, no `::ffff:` unmapping                                                                          |
| Its test locks the blind spots in place by omission, not by assertion              | **Confirmed** | `Server/api/diagnostics_handler_test.go:202-232` has no CGNAT, link-local or mapped case; `203.0.113.1` (TEST-NET-3) is asserted `false`                                                                     |
| A correct, tested address classifier already exists in this repo                   | **Confirmed** | `Server/safefetch/classify.go:26-65` — full IANA special-purpose table incl. `100.64.0.0/10` "carrier-grade NAT (RFC6598)", with `Unmap` first at `:99`                                                      |
| …but its semantics are an SSRF policy, not a topology report                       | **Confirmed** | `ClassifyAddr` returns an error for documentation/benchmarking ranges too (`classify.go:35-40`). Reusing it would flip `is_private_network` for `203.0.113.1` — see Risks                                    |
| **ACME issuance failures are logged nowhere**                                      | **Confirmed** | `Server/internal/app/lifecycle.go:377` — `ErrorLog: stdlog.New(io.Discard, "", 0)`. `loadACME` returns `m.TLSConfig()` unwrapped (`Server/auth/tls.go:209-215`)                                              |
| The `:80` ACME **listener** failure _is_ already reported honestly                 | **Confirmed** | `Server/internal/app/http.go:29-31` names renewal as the consequence. Only the issuance half is silent                                                                                                       |
| `loadACME` rejects an IP address for `tls.domain`                                  | **Confirmed** | `Server/auth/tls.go:173-176`                                                                                                                                                                                 |
| **…but its error message blames the wrong party**                                  | **Refuted**   | It says "Let's Encrypt does not issue certificates for IP addresses" (`tls.go:175`). The PRD's own re-check records LE issuing IP certificates since **2026-01-15** (PRD:151-157)                            |
| The server always binds every interface, so "bound to the wrong NIC" is impossible | **Confirmed** | `Server/internal/app/lifecycle.go:369` — `a.addr = fmt.Sprintf(":%d", a.cfg.Server.Port)`. One less thing the report has to guess at                                                                         |
| `/health` performs no network I/O and must stay that way                           | **Confirmed** | `runHealthChecks` = hub liveness + DB ping (1s budget) + free disk (`Server/api/router.go:668-681`); result cached behind `healthCacheTTL` at `:634`                                                         |
| The only bounded network call on the diagnostics path is the LiveKit health check  | **Confirmed** | `Server/ws/hub_livekit.go:30-35` → `Server/ws/livekit_process.go:361-379`, `context.WithTimeout(ctx, 3*time.Second)`                                                                                         |
| No outbound public-IP / STUN / echo-service dependency exists in `Server/`         | **Confirmed** | Repo-wide grep for `ipify`, `checkip`, `myip`, `icanhazip`, `opendns`, `stun` finds nothing outside a LiveKit config comment                                                                                 |
| **The repo has already refused an outbound probe on privacy grounds, once**        | **Confirmed** | `Server/internal/app/banner.go:98-100`: the previous UDP "dial" sent no packet, "but a network capture still saw a `connect()` to it at every start, which is exactly what BPR-055's proof must not contain" |
| BPR-055 forbids automatic telemetry and requires diagnostics stay local            | **Confirmed** | `docs/plans/beta-product-requirements-2026-08-23.md:84`; pinned by `Server/internal/app/no_telemetry_capture_test.go` (a dial recorder over `http.DefaultTransport`)                                         |
| An outbound dependency **does** already exist in the voice path, LiveKit-owned     | **Confirmed** | Generated `livekit.yaml` sets `use_external_ip: true` (`Server/ws/livekit_process.go:134`); livekit-server resolves its external IP via STUN. OwnCord's own process still dials nothing                      |
| "A clean install contains no reverse-proxy prerequisite" (BPR-013 acceptance)      | **Confirmed** | `docs/deployment.md:330-332`: "OwnCord terminates its own TLS by default and does not require a reverse proxy." nginx appears only as an optional topology at `:348-370`                                     |
| **BPR-014 cannot be closed by this milestone**                                     | **Confirmed** | Its acceptance (`docs/plans/beta-requirements-traceability-2026-08-23.md:60`) requires HTTPS/WSS integration coverage for IPv4 and IPv6 origins — blocked by the B6-3 deferral                               |
| No new public route is needed, so `publicSurface` is untouched                     | **Confirmed** | The endpoint being extended is already admin-gated; `Server/api/auth_posture_test.go:32-55` fails only on _undeclared public_ routes                                                                         |
| No consumer reads `is_private_network`, so its semantics can be corrected          | **Confirmed** | Repo-wide grep across `Client/src` and `Server/admin` returns nothing                                                                                                                                        |
| No schema change is needed                                                         | **Confirmed** | Every input is `*config.Config` plus the interface table; nothing is persisted. `db-change` skill does not apply                                                                                             |
| The route index in `docs/api.md` is generated; the prose beside it is not          | **Confirmed** | Index row at `docs/api.md:128` (inside the gendocs markers); hand-written prose at `docs/api.md:4105-4130`                                                                                                   |

## Decisions the milestone brief required, recorded explicitly

### Decision 1 — Outbound reachability helper: **no, and pinned by a test**

**Not added.** Not off-by-default-but-present; absent.

Three reasons, in order of weight:

1. **The repo already made this decision once, against a strictly weaker
   probe.** `banner.go:98-100` records that a UDP "dial" which _sent no packet_
   was removed because a packet capture saw a `connect()` at every start — and
   names BPR-055's proof as the reason. A helper that completes a real TCP
   round trip to a third party is the same act, louder. Reversing that for a
   diagnostic would be an owner-level decision, not a milestone-level one.
2. **BPR-055 requires diagnostics stay local** and forbids automatic outbound
   product traffic (`beta-product-requirements-2026-08-23.md:84`). A callback
   helper tells a third party this server exists, at its address, at a
   timestamp — which for a self-hosted privacy-first server is the disclosure
   it is trying to avoid, and BPR-012 rules out OwnCord operating the helper
   itself.
3. **It would not answer the question it appears to answer.** A callback tells
   you one TCP connection arrived, or did not. A negative does not distinguish
   CGNAT from a missing forwarding rule from an ISP block from a transient
   helper outage, and a positive says nothing about the UDP 50000-60000 range
   where most real voice failures live. An operator would read the verdict as
   authoritative anyway. A confident wrong answer is the specific failure this
   milestone exists to prevent — worse than no answer.

**Recorded either way, as asked:** if a future owner decision reverses this, the
helper must be opt-in, default off, documented in `docs/trust-model.md` as a
disclosure, and must report "reachable / not reachable / could not ask" as three
outcomes rather than two. That is not B6-6.

**Pinned, not merely omitted.** Task 5 adds an absence test mirroring
`Server/api/external_dependency_absence_test.go`'s vocabulary-pinning approach:
the reachability code path opens no socket and resolves no name. The day
someone adds a helper, that test fails and the decision is re-made deliberately.

**One honest caveat, documented rather than hidden:** the voice path already has
an outbound dependency OwnCord does not own — the generated `livekit.yaml` sets
`use_external_ip: true` (`Server/ws/livekit_process.go:134`), so livekit-server
queries STUN at start. B6-6 documents that in `docs/port-forwarding.md` and does
not extend, reuse or launder a reachability verdict through it.

### Decision 2 — Probe timeouts: **no new network I/O, so no new budget**

The reachability report performs **zero** network I/O. Its inputs are
`net.InterfaceAddrs()` (a kernel table read — a syscall, not a packet) and
`*config.Config`. There is nothing to time out.

The budget that does exist on that endpoint is the pre-existing LiveKit health
check: **3 seconds**, `Server/ws/livekit_process.go:364`. Unchanged. The whole
endpoint therefore stays inside `3s + ε`, and the middleware chain already rate
limits it to 5/min/IP (`router.go:209`).

**`/health` is not touched at all.** No reachability field, no new dependency in
`healthDeps`, no new call in `runHealthChecks`. That is asserted, not assumed —
Task 6's `TestHealthResponseCarriesNoReachabilityFields`.

### Decision 3 — Where the report surfaces: **banner + admin diagnostics + docs, and nowhere else**

Justified from what each seam already does, not from preference:

| Surface                                   | Why this one                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Startup banner** (`banner.go:33-57`)    | It is where the inaccuracy is currently printed. It is also the one output every owner sees without being told to look, and the file already does exactly this job — `warnLowDisk:81-93` is the precedent for a boot-time honest warning |
| **Admin diagnostics** (existing endpoint) | H-8 already ruled that network topology is admin-only (`router.go:205-206`). Detail belongs behind the gate that already holds topology; extending the aggregator adds no route and no public surface                                    |
| **`docs/port-forwarding.md`**             | Roadmap workstream 4 says "**document** blocked-port, CGNAT, hairpin-NAT, dynamic-IP, and firewall limits honestly" (`repo-health-roadmap-2026-08-23.md:786-788`). The doc is the required artefact                                      |
| ~~`/health`~~                             | Rejected. `/health` is a liveness probe on a cache (`router.go:634`); reachability is neither live-changing nor probe-shaped, and a monitor flapping on NAT topology is a false alarm                                                    |
| ~~A new public endpoint~~                 | Rejected. It would hand an unauthenticated caller the host's interface topology, and `publicSurface` is shrink-only for exactly that reason                                                                                              |

**Owner amendment (2026-09-11):** the admin-diagnostics half is additionally
gated by `server.reachability_report_enabled`, default off. The banner half is
not. See "What decision 3 changes" above.

## Patterns to Mirror

| Category                | Source                                                | Pattern                                                                             |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tiny shared utility pkg | `Server/diskutil/`                                    | One narrow job, no dependency on `api` or `app`, usable from both                   |
| Address prefix table    | `Server/safefetch/classify.go:26-65`                  | `netip.MustParsePrefix` rows each carrying a `why` string and its RFC               |
| Unmap before judging    | `Server/safefetch/classify.go:96-99`                  | `addr.Unmap()` first, or `::ffff:10.0.0.1` bypasses every IPv4 rule                 |
| Named-class table test  | `Server/safefetch/classify_test.go:23`                | One case per class, named, so a deleted row fails loudly                            |
| Boot-time honest warn   | `Server/internal/app/banner.go:81-93` (`warnLowDisk`) | Say the consequence, not just the fact; stay silent when the answer is "unknown"    |
| Config-shape warning    | `Server/api/router.go:60-73` (`warnOnServerConfig`)   | One `slog.Warn` per misconfiguration, naming the key and what it will not do        |
| Diagnostics sub-struct  | `Server/api/diagnostics_handler.go:20-37`             | A named `…Diag` struct with explicit json tags, composed into `diagnosticsResponse` |
| Bounded external call   | `Server/ws/livekit_process.go:364`                    | `context.WithTimeout` at the call site, 3s                                          |
| Absence pinned by test  | `Server/internal/app/no_telemetry_capture_test.go`    | A dial recorder over `http.DefaultTransport`; absence proved, not asserted in prose |
| Absence pinned by scan  | `Server/api/external_dependency_absence_test.go:38`   | A vocabulary regex over production imports, allowlisted by name, never loosened     |
| Pure core, thin shell   | `Server/api/router.go:668` (`runHealthChecks`)        | Decision logic takes injected deps so tests need no real environment                |
| Hand-written API prose  | `docs/api.md:4105-4130`                               | Prose block beside the generated index row; never edit between the markers          |

## Files to Change

| File                                                      | Action | Why                                                                                           |
| --------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `Server/netclass/classify.go`                             | NEW    | `Kind` classification incl. CGNAT; `Rank` for address preference; pure, injectable            |
| `Server/netclass/classify_test.go`                        | NEW    | One named case per class; the CGNAT and mapped-IPv4 cases that do not exist today             |
| `Server/netclass/report.go`                               | NEW    | `Report` built from injected `[]netip.Addr` + config, incl. the `Undeterminable` list         |
| `Server/netclass/report_test.go`                          | NEW    | Five injected topologies; no test touches a real interface                                    |
| `Server/internal/app/banner.go`                           | UPDATE | Rank-based address pick + the honesty line; `getOutboundIP` splits into a pure inner function |
| `Server/internal/app/banner_test.go`                      | UPDATE | Injected-address tests for the pick and the label                                             |
| `Server/api/diagnostics_handler.go`                       | UPDATE | `reachability` block; `isPrivateIP` delegates to `netclass`                                   |
| `Server/api/diagnostics_handler_test.go`                  | UPDATE | New block assertions; **correct** the CGNAT/link-local expectations the table omits today     |
| `Server/api/router.go`                                    | UPDATE | `warnOnServerConfig`: warn when `voice.node_ip` is a non-global address                       |
| `Server/api/router_test.go`                               | UPDATE | That warning's test                                                                           |
| `Server/auth/tls.go`                                      | UPDATE | Log ACME issuance failure once, actionably; correct the stale IP-rejection message            |
| `Server/auth/tls_test.go`                                 | UPDATE | Injected failing issuer; assert the log names inbound `:80`                                   |
| `docs/port-forwarding.md`                                 | UPDATE | The honest-limits rewrite — the milestone's required artefact                                 |
| `docs/deployment.md`                                      | UPDATE | "Firewall and Ports" gains the unqualified-paths note and the cross-link                      |
| `docs/api.md`                                             | UPDATE | Hand-written prose for the new `reachability` fields; the index row needs no change           |
| `Server/config/config.go`                                 | UPDATE | `server.reachability_report_enabled`, default off (owner decision 3)                          |
| `Server/config/config_test.go`                            | UPDATE | Pin the default-off, mirroring the `browser_client_enabled` test                              |
| `docs/plans/beta-requirements-traceability-2026-08-23.md` | UPDATE | BPR-014 recorded as blocked on B6-3 (owner decision 4)                                        |
| `CHANGELOG.md`                                            | UPDATE | Unreleased entry                                                                              |
| `docs/plans/b6-…prd.md`                                   | UPDATE | B6-6 row → `in-progress`, then `complete`; Plan cell → this file                              |

No migration. No `protocol/schema.json` change (this is REST and log output; the
schema carries wire-message constants only). No `publicSurface` entry.

## Tasks

### Task 1: `Server/netclass` — the classifier, test first

- **Action**: `Kind` is one of `loopback`, `private`, `cgnat`, `link_local`,
  `unique_local`, `global`, `other`. `Classify(netip.Addr) Kind` unmaps first,
  then matches an explicit prefix table modelled on
  `Server/safefetch/classify.go:26-65`. `Rank(Kind) int` orders
  `global > private > unique_local > cgnat > link_local > loopback` for address
  preference.
- **Test first**: the table test goes red before `classify.go` exists. It must
  include `100.64.1.2 → cgnat`, `::ffff:192.168.1.1 → private`,
  `169.254.1.1 → link_local`, `fe80::1 → link_local`, `fd12::1 → unique_local`,
  `8.8.8.8 → global`.
- **Watch**: do **not** call `safefetch.ClassifyAddr`. Its job is "may this
  server dial it" and it refuses documentation and benchmarking ranges, which
  would silently reclassify `203.0.113.1`. Mirror its table; do not import its
  verdict.
- **Watch**: `netip.Addr.IsPrivate` returns **false** for `100.64.0.0/10`
  (measured). CGNAT needs its own prefix row or it stays invisible.
- **Validate**: `(cd Server && go test ./netclass/...)`

### Task 2: The banner stops presenting a LAN address as the server's address

- **Action**: split `getOutboundIP` into `pickBannerAddr(addrs []netip.Addr)
(netip.Addr, netclass.Kind)` — pure, injectable — and a thin
  `net.InterfaceAddrs()` caller. Pick by `netclass.Rank`, IPv4 before IPv6
  within a rank, so a VPS with a public IP and a Docker bridge prints the
  public one. Add **one** qualifier line to the banner:
  - `global` → `Reachable from the internet only if inbound TCP <port> is open. This server cannot verify that from here — see docs/port-forwarding.md`
  - `private` / `unique_local` → `LAN only — this host has no public address. Remote access needs port forwarding: docs/port-forwarding.md`
  - `cgnat` → the same, plus: `<addr> is in 100.64.0.0/10 — either a carrier-NAT WAN address (inbound forwarding is usually impossible) or Tailscale. This server cannot tell which.`
  - `loopback` (no other address) → `No non-loopback address found; only this machine can reach the server.`
- **Test first**: `TestPickBannerAddr_PrefersPublicOverPrivate` and
  `TestBannerQualifierNamesLANOnlyForPrivateAddress` go red first.
- **Why this is the central row**: it is the milestone's failure mode in its
  purest form — the application succeeding out loud while the network limit
  goes unmentioned.
- **Negative control (required)**: revert `pickBannerAddr` to the old
  first-`IsGlobalUnicast`-wins behaviour, confirm
  `TestPickBannerAddr_PrefersPublicOverPrivate` fails, revert the revert, and
  record it in Acceptance.
- **Validate**: `(cd Server && go test ./internal/app/...)`

### Task 3: The `reachability` block on the existing admin endpoint, behind a flag

- **Action first**: add `server.reachability_report_enabled` to `ServerConfig`
  (koanf `reachability_report_enabled`, bool, zero-value false, **no**
  `defaults()` entry) — the `BrowserClientEnabled` shape at
  `Server/config/config.go:238`. Pin the default with a config test the way
  `config_test.go:558-580` pins the browser flag.
- **Action**: `netclass.Report` takes injected `[]netip.Addr` + the config and
  returns, as JSON under a new `reachability` key **when the flag is on**:
  - `listen_port`, `binds_all_interfaces` (always true — `lifecycle.go:369`)
  - `local_addresses`: `[{addr, kind}]`, loopback included, never elided
  - `has_global_address`: bool. False means the host is behind NAT of some kind
  - `cgnat_range_present`: bool, **with** `cgnat_note` naming both explanations
  - `required_ports`: the chat port, plus LiveKit 7880/TCP, 7881/TCP,
    50000-60000/UDP when voice is configured
  - `voice_node_ip_kind`: the `Kind` of `voice.node_ip` when set
  - `tls_mode`, and `public_ip_https_supported: false` with a reason string
  - **`undeterminable`**: the honesty payload — a list of
    `{fact, why, how_to_check}` entries covering inbound reachability of each
    port, CGNAT, hairpin NAT, ISP port blocking, and public-IP stability, each
    pointing at the owner-side check in `docs/port-forwarding.md`
- **Test first**: five injected topologies — VPS (public v4), home LAN behind
  NAT, CGNAT/Tailscale host, IPv6-only, loopback-only. Assert on the report
  struct, never on the machine's real interfaces.
- **Watch**: `undeterminable` is never empty and never conditional. The report
  states its own limits on every topology, including the one where everything
  looks fine.
- **Watch**: `Report` must not take a `context.Context` or an `http.Client`.
  Decision 1 is enforced by the signature having nowhere to put a dial.
- **Watch**: with the flag off the `reachability` key is **absent** from the
  JSON, not present-and-empty — `omitempty` on a pointer field, so an operator
  reading the response cannot mistake "switched off" for "nothing to report".
- **Watch**: the flag gates **only** this block. The banner qualifier (Task 2)
  and the `warnOnServerConfig` warnings (Task 6c) are never gated, and
  `TestReachabilityBannerIsNotGatedByTheFlag` pins that split.
- **Validate**: `(cd Server && go test ./netclass/... ./api/... ./config/...)`

### Task 4: `isPrivateIP` learns the ranges this milestone is about

- **Action**: `isPrivateIP` delegates to `netclass.Classify`, returning true for
  `loopback`, `private`, `unique_local`, `cgnat` and `link_local`. Add
  `address_class` (the `Kind` string) to `clientDiag` so the boolean's meaning
  is no longer ambiguous.
- **Action**: extend `TestIsPrivateIP` with the missing classes. `100.64.1.2`
  changes from `false` to `true`: a client arriving from carrier-NAT or
  tailnet space is not on the public internet, and `docs/tailscale.md:19-24`
  already treats that range as trusted-adjacent. **This corrects an expectation
  the test never asserted; it weakens nothing.** `203.0.113.1` stays `false` —
  see the Risks row.
- **Why not fold this into Task 1**: Task 1 is a new package with no callers.
  This is a behaviour change to a shipped field, and it is reviewed as one.
- **Validate**: `(cd Server && go test ./api/ -run 'Diagnostics|PrivateIP')`

### Task 5: Pin the refusal (Decision 1)

- **Action**: `Server/netclass/no_outbound_test.go`, mirroring
  `Server/internal/app/no_telemetry_capture_test.go`: install a dial recorder
  over `http.DefaultTransport` and `net.DefaultResolver`, build a `Report` for
  every injected topology, assert **zero** dials and **zero** lookups. Plus an
  import scan over `Server/netclass/*.go` refusing `net/http`, `crypto/tls` and
  any STUN vocabulary, allowlisted by name if a legitimate collision ever
  appears — never by loosening the pattern.
- **Why**: prose in a plan does not survive a refactor. A test does.
- **Validate**: `(cd Server && go test ./netclass/...)`

### Task 6: Say the silent failures out loud

Three small, independent honesty fixes. Each is test-first.

- **6a — ACME issuance failure is currently discarded.** Wrap
  `autocert.Manager.GetCertificate` in `loadACME` so the first failure per
  domain logs once at `Error`: the domain, the error, and the actionable cause
  — inbound TCP `:80` must be reachable from the internet for HTTP-01. Log
  once, not per handshake; `ErrorLog: io.Discard` stays as it is
  (`lifecycle.go:377` suppresses handshake noise deliberately and that comment
  is correct).
  **Test**: inject a `GetCertificate` that errors, capture the `slog` output,
  assert the message names `:80`. No network.
- **6b — the IP-rejection message blames the wrong party.** `tls.go:175` says
  "Let's Encrypt does not issue certificates for IP addresses". The PRD's own
  re-check (PRD:151-157) records LE issuing IP certificates since 2026-01-15.
  Rewrite it to name the real limit: **this build's ACME client** cannot
  request a certificate for an IP address, and B6-3 is deferred. This is a
  string and a test; it starts no certificate work.
- **6c — a non-global `voice.node_ip` breaks remote voice silently.** Today
  `livekit_process.go:107-114` validates only for unsafe YAML characters. Add a
  `warnOnServerConfig` line when `voice.node_ip` classifies as anything but
  `global`: remote clients will receive an unroutable ICE candidate and voice
  will connect-then-fail-silently. Warn only; never refuse — a LAN-only or
  tailnet-only operator has a legitimate reason.
- **Validate**: `(cd Server && go test ./auth/... ./api/...)`

### Task 7: Rewrite `docs/port-forwarding.md`

- **Action**: keep the working parts (ports table, router steps, dynamic DNS),
  and add what a stranger actually hits, each as _symptom → cause → the check
  you run_:
  - **Blocked port** — ISPs block inbound 80/443 on residential lines; 8443 is
    usually fine. Check from a phone on mobile data, not from the LAN.
  - **CGNAT** — what it is, why no port forward can work through it, how to
    recognise it (router WAN address in `100.64.0.0/10`, or your router's WAN
    address differs from what a what-is-my-IP page reports), and that the fix
    is Tailscale (`docs/tailscale.md`) or a static IP from the ISP. State
    plainly: **the server cannot detect this for you, and here is why.**
  - **Hairpin NAT** — LAN clients cannot reach the public address even though
    remote clients can. Same statement: not detectable from the server.
  - **Dynamic IP** — expand the existing one-liner into the failure it causes
    (every client's saved address breaks at the next lease) and its fix.
  - **Firewall** — host firewall _and_ router firewall, both directions.
  - **Voice is where port forwarding actually fails**: 7880/TCP, 7881/TCP and
    **50000-60000/UDP**, why the UDP range cannot go through an HTTP reverse
    proxy (`docs/deployment.md:341-343`), and why `voice.node_ip` must be the
    public address. Symptom: joining voice _succeeds_ and then nobody hears
    anything.
  - **What LiveKit sends outbound**: `use_external_ip: true` means
    livekit-server queries STUN at start. Say so; it is the one outbound call
    in a default install.
  - **What this build does not do**, in its own section: no HTTPS on a bare
    public IP (B6-3 deferred); domain ACME implemented but not exercised at
    release quality; no guided LAN/offline device-trust install (B6-4); no
    qualified certificate lifecycle (B6-5); the server never verifies inbound
    reachability, by design (BPR-055) — with the owner-side check for each.
  - **No reverse proxy is required** (BPR-013), cross-linked to
    `docs/deployment.md:330`.
- **Action**: `docs/deployment.md` "Firewall and Ports" (`:566`) gains the
  cross-link and the unqualified-paths note.
- **Validate**: `npm run format`; read it as a stranger would.

### Task 8: API docs and the PRD row

- **Action**: extend the hand-written `GET /api/v1/diagnostics/connectivity`
  prose at `docs/api.md:4105-4130` with the `reachability` block and the new
  `address_class` field. Run gendocs; the route index should be **unchanged**
  (no new route), and `git diff --exit-code` on the generated docs proves it.
- **Action**: flip the B6-6 row in the PRD milestone table (`:137`) to
  `complete` and set its Plan cell to this file. **Read the rendered cell
  back** — a previous PR claimed a flip that had not happened.
- **Validate**: `(cd Server && go run -tags otel,wazero ./cmd/gendocs)` then
  `git diff --exit-code docs/api.md docs/schema.md docs/server-configuration.md`

## Validation

```bash
(cd Server && go test ./netclass/... ./api/... ./auth/... ./internal/app/...)
(cd Server && go run -tags otel,wazero ./cmd/gendocs)   # never hand-edit gendocs blocks
npm run format
```

Then the **`ci-check` skill** — four build-tag variants plus the deadlock pass.
Read its section list, not the exit code (`run.mjs` fails fast but still exits
0). A default `go build && go test` proves nothing about the tagged variants.

### What cannot be tested, stated rather than faked

CI cannot produce real CGNAT, a real hairpin-NAT router, a real ISP port block
or a real dynamic-IP change. **No test in this plan depends on network
topology.** Every classification and report test injects `[]netip.Addr` and a
`*config.Config`. The consequences, accepted:

- The banner's _real_ address pick is exercised only through `pickBannerAddr`;
  `net.InterfaceAddrs()` itself is never asserted on, because its output is the
  runner's topology.
- `use_external_ip: true` causing livekit-server to reach STUN is documented,
  not tested — it is the companion process's behaviour, not OwnCord's.
- 6a proves the _log line_ on an injected issuer error, not that a real ACME
  failure produces it end to end. That end-to-end proof belongs to B6-3/B6-5.

## Risks

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                     |
| --------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| The report grows a probe later and quietly becomes a tracker                | Medium     | High   | Task 5's dial-recorder + import-scan absence test; `Report` has no `context.Context` and no client in its signature            |
| `is_private_network` flipping for `100.64/10` breaks a consumer             | Low        | Low    | Grep found **no** consumer in `Client/src` or `Server/admin`; `address_class` is added so the boolean is never the only signal |
| Reusing `safefetch.ClassifyAddr` silently reclassifies documentation ranges | Medium     | Medium | Task 1 mirrors its table but not its verdict; `203.0.113.1` stays `false` and the test keeps asserting so                      |
| The banner qualifier becomes noise every operator learns to ignore          | Medium     | Medium | One line, not a paragraph; it changes with the address class rather than always printing the same warning                      |
| The `cgnat_range_present` observation gets read as a CGNAT verdict          | Medium     | High   | The field never appears without `cgnat_note` naming Tailscale as the other explanation; asserted in the report test            |
| Task 6a's wrapper interferes with autocert's own retry/caching              | Low        | Medium | The wrapper only observes and logs; it returns the underlying error unchanged and holds no state beyond a seen-once set        |
| Touching `Server/auth/tls.go` collides with B6-3 when it is picked up       | Medium     | Low    | 6a and 6b are a log line and a string; they carry no certificate logic for B6-3 to unpick — see Open question 2                |
| `voice.node_ip` warning fires on legitimate LAN-only installs               | High       | Low    | It is a `Warn` naming the consequence, never a refusal; `warnOnServerConfig` is exactly this pattern already                   |
| B6-6 is read as closing BPR-014                                             | Medium     | High   | It does not, and the PRD row says so. Open question 3 puts it to the owner                                                     |

## Open questions for the owner

1. ~~**Does the banner change go in, or should the honesty line be
   log-only?**~~ **Decided 2026-09-11: banner.** Task 2 as written.
2. ~~**Is touching `Server/auth/tls.go` acceptable while B6-3 – B6-5 are
   deferred?**~~ **Decided 2026-09-11: yes, both 6a and 6b.**
3. ~~**Should the `reachability` block ship unconditionally?**~~ **Decided
   2026-09-11: behind `server.reachability_report_enabled`, default off.** The
   banner and the startup warnings stay ungated — see "What decision 3 changes"
   above for why the split falls there.
4. ~~**How should traceability record BPR-014?**~~ **Decided 2026-09-11:
   blocked on B6-3**, not partially satisfied here.
5. **Still open — should the `undeterminable` list also surface in the support
   bundle?** BPR-055 mentions user-initiated support-bundle export; the bundle
   is B6-13's scope. Not taken here. Flagged so B6-13 picks it up rather than
   reinventing the wording.

## Acceptance

- [x] A public address outranks a private one in the banner pick (`TestPickBannerAddr_PrefersPublicOverPrivate`) — **negative-controlled**: reverting `pickBannerAddr` to the old first-`IsGlobalUnicast`-wins pick made it fail with `pickBannerAddr([172.17.0.1 93.184.216.34]) = "172.17.0.1", want "93.184.216.34"` — the Docker-bridge case, exactly — then the revert was reverted
- [x] A private-only host's banner says the address is LAN only and names the fix (`TestBannerQualifierNamesLANOnlyForPrivateAddress`)
- [x] A `100.64.0.0/10` address is labelled with **both** explanations, never as a CGNAT verdict (`TestBannerQualifierNamesBothCGNATExplanations`, and `TestReport_CGNATIsObservedNeverConcluded` for the JSON)
- [x] `netclass.Classify` returns `cgnat` for `100.64.1.2`, which no classifier in this repo's request path did before (`TestClassify_NamesEveryKind`)
- [x] `::ffff:192.168.1.1` is judged as `192.168.1.1`, not as an IPv6 address (`TestClassify_UnmapsIPv4Mapped`)
- [x] The reachability report is correct on five injected topologies and reads no real interface (`TestReport_InjectedTopologies`)
- [x] `undeterminable` is non-empty on **every** topology, including the fully-public one (`TestReport_AlwaysStatesItsOwnLimits`), and names all five limits (`TestReport_UndeterminableNamesEveryLimitTheMilestoneListed`)
- [x] Building a report opens no socket and resolves no name (`TestReport_MakesNoOutboundCall`) — **negative-controlled** with an injected `http.Get`. Its blind spot is a raw `net.Dial`, which no Go hook intercepts; `TestNetclassSourceMentionsNoDial` covers that and was negative-controlled separately
- [x] `Server/netclass` imports no HTTP, TLS or STUN vocabulary (`TestNetclassImportsNoNetworkClient`) — **negative-controlled**
- [x] `isPrivateIP` reports CGNAT, link-local and IPv4-mapped addresses as non-public (`TestIsPrivateIP`, extended by 11 cases)
- [x] `server.reachability_report_enabled` defaults to **false** on a fresh config, and the shipped template keeps it commented (`TestLoadReachabilityReportDisabledByDefault`)
- [x] With the flag on, the diagnostics response carries `reachability` (`TestDiagnosticsReportsReachabilityWhenEnabled`); `client.address_class` is reported either way (`TestDiagnosticsReportsClientAddressClass`)
- [x] With the flag off, the `reachability` key is **absent**, not empty (`TestDiagnosticsOmitsReachabilityWhenDisabled`)
- [x] The startup warnings print regardless of the flag (`TestReachabilityWarningsAreNotGatedByTheFlag`); the banner qualifier never takes the config, so it is ungated by construction
- [x] `/health` gains no reachability field, asserted with the flag switched **on** so a leak would be caught (`TestHealthResponseCarriesNoReachabilityFields`)
- [x] An ACME issuance failure logs once, naming inbound `:80` (`TestLoadACME_LogsIssuanceFailureWithReachabilityCause`), and a success logs nothing (`TestLoadACME_SuccessIsNotLogged`)
- [x] The IP-rejection error names this build's client, not Let's Encrypt (`TestLoadACME_IPErrorNamesTheRealLimit`)
- [x] A non-global `voice.node_ip` warns that remote voice will fail silently (`TestWarnOnServerConfig_NonGlobalNodeIP`), and stays quiet when voice is off (`TestWarnOnServerConfig_NodeIPSilentWhenVoiceIsOff`)
- [x] `docs/port-forwarding.md` covers CGNAT, hairpin NAT, blocked ports, dynamic IP, firewalls, the LiveKit UDP range, and names every path this build leaves unqualified — 48 lines to 208, opening with a table of what the server can and cannot detect
- [x] gendocs runs clean and the route index is **unchanged** — no new route. The only generated change is the new config key's two rows
- [x] `publicSurface` is untouched and the posture test passes unchanged
- [x] `docs/server-configuration.md` gains the new key via gendocs, not by hand
- [x] BPR-014 is recorded as blocked on B6-3 in the traceability document, and BPR-013's row records what B6-6 did satisfy
- [x] `ci-check` green: four build-tag variants, `go vet`, `golangci-lint` (0 issues), the deadlock pass, the untagged `admin` leg, genprotocol drift, `check:docs` and `check:hygiene` — locally; `-race ./...` and the tag-gated legs green on CI
- [x] The B6-6 PRD row reads `complete` with this file in its Plan cell — the cell was parsed back after the edit, not eyeballed

## Two traps this milestone hit, recorded for the next plan

Neither is about B6-6's subject; both cost real time and would cost it again.

1. **A system-installed `golangci-lint` can silently be the wrong one.** This
   container ships v2.5.0 built with `go1.25.1`, which refuses a module
   targeting `go1.26` with "the Go language version used to build
   golangci-lint is lower than the targeted Go version". That reads as "this
   gate cannot run here", and it is not — fetching the version CI pins
   (v2.11.3, built with `go1.26.1`) runs clean. Three findings reached CI
   because the gate was written off instead of re-fetched.
2. **gendocs attributes a config key to whichever section first mentions it.**
   Writing `` `voice.node_ip` `` inside a Server-section table row moved that
   key's generated entry from Voice to Server. Name only the key the row is
   about.

## Status

Plan written 2026-09-11 at `dev` `6a7077fc` and reviewed the same day. All four
open questions answered (see "Owner decisions" above); question 5 is new and
deferred to B6-13. Implementation follows test-first.
