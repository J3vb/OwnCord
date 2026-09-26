// Package safefetch is the server's one bounded outbound-content boundary.
//
// Every server-side fetch of content the server did not choose goes through a
// Fetcher: the GIF proxy (Server/api/gif_handler.go) and the plugin `http`
// host capability (Server/plugin/host_http.go). Both used to carry their own
// partial version of this policy, and neither carried all of it.
//
// # What one fetch is bounded by
//
// Per hop, in order, before a single packet leaves:
//
//   - the URL parses, its scheme and port are on the policy's allowlists, and
//     it carries no embedded credentials;
//   - the host resolves to every A and AAAA answer, IPv4-mapped addresses
//     normalised, and the fetch is refused if *any* answer is non-global
//     (ClassifyAddr) — one poisoned record among ten refuses the request,
//     because dialling the good ones would leave the attacker one retry away;
//   - the connection is made only to those validated addresses. The hostname
//     is kept for SNI and certificate validation and is never resolved a
//     second time, which is what closes the DNS-rebinding window;
//   - automatic redirects are off. At most Policy.MaxRedirects hops are
//     followed by hand, re-running everything above on each one and refusing
//     a scheme downgrade;
//   - the whole fetch, connect through last body byte, sits under one
//     deadline;
//   - the body is bounded twice while being read — once on the wire and once
//     after inflation, because a Content-Length header is a claim and a
//     gzip stream can be four orders of magnitude larger than its wire form;
//   - the media type is checked twice: as declared, and as sniffed from the
//     bytes actually received;
//   - and the number of fetches in flight is capped, per Fetcher and across
//     the process.
//
// The policy is documented as a contract in docs/trust-model.md, "Desktop
// preview destination policy (C-09)", clauses 2 through 6. Clauses 1, 7 and 8
// are the desktop broker's and are B7's.
//
// # What is deliberately not here (B5 decision 2)
//
// Aggregate cross-caller byte budgets and byte-weighted cache eviction are
// B7's, not this package's. The server's outbound surface is one hard-coded
// host plus an operator allowlist that defaults to empty, so there is close to
// nothing to aggregate and no test of an aggregate budget here could fail
// honestly. The interface is shaped so B7 adds them without a rewrite:
//
//   - every fetch passes one admission point, Fetcher.Fetch's gate acquire,
//     which is where a byte budget is charged and refunded;
//   - every byte of every body passes one accounting point, limitedReader,
//     which already counts what it lets through;
//   - Policy carries the per-fetch numbers, so a process-wide budget is a new
//     field plus a second gate rather than a change to any call site.
//
// This package fills no cache, so cache partitioning and expiry are not in
// scope here either; they belong to whatever B7 puts a cache in front of.
//
// # Using it
//
// Build one Fetcher per call site at start-up and share it — the concurrency
// cap and the connection pool both live in it:
//
//	var fetcher = safefetch.MustNew(safefetch.Policy{
//		Schemes:              []string{"https"},
//		Ports:                []int{443},
//		ContentTypes:         []string{"application/json", "text/plain"},
//		MaxRedirects:         0,
//		Deadline:             10 * time.Second,
//		MaxBytes:             2 << 20,
//		MaxDecompressedBytes: 2 << 20,
//		MaxConcurrent:        8,
//	})
//
//	resp, err := fetcher.Fetch(ctx, safefetch.Request{URL: u})
//
// New rejects a policy with a missing ceiling rather than filling in a silent
// default, so a call site cannot end up unbounded by omission.
package safefetch
