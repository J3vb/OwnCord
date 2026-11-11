// Package safefetch is the server's one bounded outbound-content boundary.
//
// Every server-side fetch of content the server did not choose goes through a
// Fetcher (the GIF proxy and the plugin `http` host capability).
//
// # What one fetch is bounded by
//
// Per hop, before a single packet leaves:
//
//   - the URL parses, its scheme and port are allowlisted, and it carries no credentials;
//   - the host resolves to every A and AAAA answer and is refused if any is
//     non-global (ClassifyAddr), since dialling the good ones would leave the
//     attacker one retry away;
//   - the connection goes only to those addresses; the hostname is never
//     resolved a second time, closing the DNS-rebinding window;
//   - redirects are followed by hand, re-running every check and refusing a
//     scheme downgrade;
//   - the whole fetch sits under one deadline;
//   - the body is bounded on the wire and after inflation, since Content-Length
//     is a claim and gzip can be far larger than its wire form;
//   - the declared and sniffed media types must both be allowlisted and agree;
//   - fetches in flight are capped per Fetcher and across the process.
//
// The contract is docs/trust-model.md (desktop preview destination policy,
// clauses 2 through 6). Aggregate byte budgets and caching are deliberately
// absent: the outbound surface is one hard-coded host plus an empty-by-default
// operator allowlist.
//
// # Using it
//
// Build one Fetcher per call site at start-up and share it; it owns the
// concurrency cap and the connection pool:
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
// New rejects a policy with a missing ceiling rather than defaulting it.
package safefetch
