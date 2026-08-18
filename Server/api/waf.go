// Package api provides the HTTP router and handlers for the OwnCord server.
//
// waf.go implements Coraza WAF middleware for OWASP CRS protection.
// Toggle via config: server.waf_enabled (default: false).
// The OWASP Core Rule Set layer mode is server.waf_crs_mode (default: detect).
package api

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"

	coreruleset "github.com/corazawaf/coraza-coreruleset/v4"
	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/types"
)

// CRS layer modes (server.waf_crs_mode). The CRS engine runs alongside the
// long-standing inline rules, which keep their blocking behavior in every mode.
const (
	// CRSModeOff disables the OWASP CRS layer entirely.
	CRSModeOff = "off"
	// CRSModeDetect evaluates the full OWASP CRS and logs matches without
	// ever blocking a request (SecRuleEngine DetectionOnly).
	CRSModeDetect = "detect"
	// CRSModeBlock evaluates the full OWASP CRS in anomaly-scoring blocking
	// mode. Only enable after reviewing detect-mode logs against real traffic.
	CRSModeBlock = "block"
)

// normalizeCRSMode maps a config string to a known CRS mode. Empty and
// unknown values fall back to detect so a typo never silently disables the
// CRS layer (and never accidentally enables blocking either).
func normalizeCRSMode(mode string) string {
	switch mode {
	case CRSModeOff, CRSModeDetect, CRSModeBlock:
		return mode
	case "":
		return CRSModeDetect
	default:
		slog.Warn("waf: unknown server.waf_crs_mode, falling back to detect",
			"mode", mode)
		return CRSModeDetect
	}
}

// newCRSWAF builds a second Coraza engine loaded with the embedded OWASP Core
// Rule Set (github.com/corazawaf/coraza-coreruleset/v4). It is kept separate
// from the inline-rules engine so the inline rules keep their exact,
// test-pinned blocking behavior regardless of the CRS mode.
//
// Rationale for defaulting to detection-only: OwnCord is a chat server, and
// chat messages routinely contain SQL-ish and HTML-ish text that the CRS is
// prone to false-positive on. Blocking mode on a chat API needs tuning
// against real traffic first; detect mode gives the operator full CRS
// visibility (every match is logged) with zero user-facing risk.
func newCRSWAF(paranoiaLevel int, block bool, onMatch func(types.MatchedRule)) (coraza.WAF, error) {
	engine := "DetectionOnly"
	if block {
		engine = "On"
	}
	return coraza.NewWAF(
		coraza.NewWAFConfig().
			WithRootFS(slashFS{coreruleset.FS}).
			WithErrorCallback(onMatch).
			WithDirectives(fmt.Sprintf(`
				Include @coraza.conf-recommended
				Include @crs-setup.conf.example

				# Paranoia level (mirrors the inline engine; CRS rule 901120
				# only defaults this if unset, so it must be set before the
				# rule files are included).
				SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=%d"

				# Allowed HTTP methods (CRS rule 911100). The CRS default is
				# "GET HEAD POST OPTIONS", but this REST API also serves
				# PUT/PATCH/DELETE routes (profile updates, blocks, pins,
				# channel management), so those must be allowed or every such
				# request scores anomaly 5 (= instant block at the default
				# threshold). id 900200 is the canonical crs-setup id for
				# this setting.
				SecAction "id:900200,phase:1,pass,t:none,nolog,setvar:'tx.allowed_methods=GET HEAD POST OPTIONS PUT PATCH DELETE'"

				# Exclude the file upload endpoint from CRS body inspection
				# (binary multipart content up to upload.max_size_mb; the
				# inline engine excludes it the same way). Rule 920420
				# ("Request content type is not allowed by policy", anomaly
				# score 5) is also removed for this route: uploads
				# legitimately post binary content types (e.g.
				# application/octet-stream) that the CRS default policy
				# rejects. Local rule ids 1-99999 are reserved for us by the
				# CRS numbering scheme.
				SecRule REQUEST_URI "@beginsWith /api/v1/uploads" "id:1001,phase:1,pass,nolog,ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"

				# Same exclusion for the other routes with a larger-than-1-MiB
				# app-level cap (see bodyCapExemptPrefixes in constants.go, and
				# the mirrored inline-engine rules 900004/900005): keeps this
				# engine's SecRequestBodyLimitAction ProcessPartial from
				# evaluating rules against a truncated buffer, and 920420
				# from rejecting their non-default content types (application/zip,
				# raw image bytes) under CRS blocking mode.
				SecRule REQUEST_URI "@beginsWith /api/v1/admin/plugins/install" "id:1002,phase:1,pass,nolog,ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"
				SecRule REQUEST_URI "@beginsWith /api/v1/users/me/avatar" "id:1003,phase:1,pass,nolog,ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"

				Include @owasp_crs/*.conf

				# Engine mode: DetectionOnly logs matches without interrupting;
				# On enforces CRS anomaly-scoring blocking.
				SecRuleEngine %s

				# We never feed response data into this engine (parity with the
				# inline engine), so don't pay for response body buffering.
				SecResponseBodyAccess Off

				# Body limits: match the app's 1 MiB non-upload cap (see
				# MaxBodySizeUnless / config.MaxMessageBytes) instead of the
				# recommended-config 12.5 MiB, and never reject on size —
				# request size enforcement belongs to the app middleware, not
				# the CRS layer. Uploads are excluded from body access above.
				SecRequestBodyLimit 1048576
				SecRequestBodyLimitAction ProcessPartial

				# Match logging goes through the error callback into slog;
				# don't also emit native audit log records.
				SecAuditEngine Off
			`, paranoiaLevel, engine)),
	)
}

// logCRSMatch is the per-rule CRS match logger. It is used for the block-mode
// default (blocked requests are rare and their per-rule detail is wanted) and
// whenever a caller supplies it explicitly (tests). The default detect-mode
// path does NOT use it — see logCRSMatchesAggregate.
func logCRSMatch(mr types.MatchedRule) {
	slog.Warn("waf: CRS rule matched",
		"rule_id", mr.Rule().ID(),
		"severity", mr.Rule().Severity().String(),
		"uri", mr.URI(),
		"msg", mr.Message(),
		"data", mr.Data(),
	)
}

// logCRSMatchesAggregate emits at most ONE log line for a request that tripped
// CRS detection rules, instead of one Warn per matched rule. In the default
// detect mode ordinary chat prose routinely trips several CRS SQLi/XSS rules
// per request (see TestWAFMiddleware_CRSBlockMode_FalsePositivesOnSQLishChatProse)
// and anomaly scoring amplifies the count, so per-rule Warn logging on the
// request goroutine is pure hot-path overhead (allocation + serialized log
// I/O + log-volume amplification). This keeps the signal — how many rules
// matched and the highest-severity one — on a single Warn and moves the full
// rule-id list to Debug. It reads only per-request transaction state (no
// shared/global state, no locks).
func logCRSMatchesAggregate(tx types.Transaction) {
	if tx == nil {
		return
	}
	matched := tx.MatchedRules()
	ids := make([]int, 0, len(matched))
	var (
		topRuleID int
		topSev    types.RuleSeverity
		topURI    string
		topMsg    string
	)
	for _, mr := range matched {
		// Internal bookkeeping rules (the setvar/ctl SecActions this package
		// installs, and CRS setup actions) carry no message and are not
		// detections; the per-rule callback skips them too (it only fires for
		// rules with logging enabled), so keep them out of the count.
		if mr.Message() == "" {
			continue
		}
		ids = append(ids, mr.Rule().ID())
		// Severity is inverted: 0 (emergency) is the most severe, 7 (debug)
		// the least. The first detection seeds the max; smaller wins after.
		if sev := mr.Rule().Severity(); len(ids) == 1 || sev < topSev {
			topSev = sev
			topRuleID = mr.Rule().ID()
			topURI = mr.URI()
			topMsg = mr.Message()
		}
	}
	if len(ids) == 0 {
		return
	}
	slog.Warn("waf: CRS detect-mode matches",
		"matches", len(ids),
		"top_rule_id", topRuleID,
		"top_severity", topSev.String(),
		"uri", topURI,
		"top_msg", topMsg,
	)
	slog.Debug("waf: CRS detect-mode matched rule ids", "rule_ids", ids)
}

// NewWAFMiddlewareCRS creates a Coraza WAF middleware with OWASP CRS rules.
// paranoiaLevel controls rule sensitivity (1=low, 2=default, 3=strict,
// 4=paranoid); crsMode selects the CRS layer mode ("off" | "detect" |
// "block", see the CRSMode* constants — unknown or empty modes fall back to
// detect). Returns nil middleware if WAF creation fails (logged as error,
// server continues).
func NewWAFMiddlewareCRS(paranoiaLevel int, crsMode string) func(http.Handler) http.Handler {
	return newWAFMiddleware(paranoiaLevel, crsMode, nil)
}

// wafInlineEngine builds the long-standing inline-rules Coraza engine used by
// newWAFMiddleware. Its rules keep their exact, test-pinned blocking behavior
// regardless of the CRS mode.
func wafInlineEngine(paranoiaLevel int) (coraza.WAF, error) {
	return coraza.NewWAF(
		coraza.NewWAFConfig().
			WithDirectives(fmt.Sprintf(`
				SecRuleEngine On
				SecRequestBodyAccess On
				SecResponseBodyAccess Off
				SecRequestBodyLimit 1048576

				# Paranoia level
				SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=%d"

				# Core rules — SQL injection
				SecRule ARGS|ARGS_NAMES|REQUEST_BODY "@detectSQLi" \
					"id:942100,phase:2,deny,status:403,log,msg:'SQL Injection detected',tag:'OWASP_CRS',tag:'attack-sqli'"

				# Core rules — XSS
				SecRule ARGS|ARGS_NAMES|REQUEST_BODY "@detectXSS" \
					"id:941100,phase:2,deny,status:403,log,msg:'XSS detected',tag:'OWASP_CRS',tag:'attack-xss'"

				# Path traversal
				SecRule ARGS|REQUEST_URI "@contains ../" \
					"id:930100,phase:2,deny,status:403,log,msg:'Path traversal detected',tag:'OWASP_CRS',tag:'attack-lfi'"

				# Command injection patterns
				SecRule ARGS|REQUEST_BODY "@rx (?:;|\||\x60|&&|\$\()" \
					"id:932100,phase:2,deny,status:403,log,msg:'Command injection detected',tag:'OWASP_CRS',tag:'attack-rce'"

				# Block common scanners
				SecRule REQUEST_HEADERS:User-Agent "@rx (?:nikto|sqlmap|nmap|masscan|dirbuster)" \
					"id:913100,phase:1,deny,status:403,log,msg:'Scanner blocked',tag:'OWASP_CRS',tag:'automation'"

				# Exclude WebSocket upgrade and health endpoints from body inspection
				SecRule REQUEST_URI "@streq /ws" "id:900001,phase:1,pass,nolog,ctl:ruleRemoveById=942100;941100;932100"
				SecRule REQUEST_URI "@streq /api/v1/health" "id:900002,phase:1,pass,nolog,ctl:ruleRemoveById=942100;941100;932100"

				# Exclude file upload endpoint from body inspection (binary content)
				SecRule REQUEST_URI "@beginsWith /api/v1/uploads" "id:900003,phase:1,pass,nolog,ctl:requestBodyAccess=Off"

				# Exclude the other routes with a larger-than-1-MiB app-level
				# cap too (see bodyCapExemptPrefixes in constants.go: 16 MiB
				# plugin installs, 2 MiB avatars). Without this, coraza's
				# default SecRequestBodyLimitAction (Reject) 413s any body
				# that reaches this engine's 1 MiB SecRequestBodyLimit before
				# the app's own, larger limit is ever consulted.
				SecRule REQUEST_URI "@beginsWith /api/v1/admin/plugins/install" "id:900004,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
				SecRule REQUEST_URI "@beginsWith /api/v1/users/me/avatar" "id:900005,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
			`, paranoiaLevel)),
	)
}

// wafCRSEngine builds the OWASP CRS layer for newWAFMiddleware. It returns the
// CRS engine (nil when the layer is off or failed to load) and whether
// detect-mode match logging is aggregated per request.
func wafCRSEngine(paranoiaLevel int, crsMode string, onCRSMatch func(types.MatchedRule)) (coraza.WAF, bool) {
	// OWASP CRS layer — a second engine so the inline rules above keep their
	// exact blocking behavior in every CRS mode. If the CRS fails to load the
	// server continues with the inline engine only (same failure philosophy
	// as above).
	//
	// aggregateCRSLog collapses detect-mode match logging to one line per
	// request (logCRSMatchesAggregate) instead of one Warn per matched rule.
	// It applies ONLY to the default detect-mode path — the hot path for
	// ordinary traffic. When a caller supplies its own onCRSMatch (tests) the
	// per-rule callback is wired so every match stays observable; in block
	// mode the per-rule logCRSMatch is kept (blocked requests are rare and the
	// per-rule detail is wanted), leaving block-mode behavior exactly as-is.
	aggregateCRSLog := false
	var crsWAF coraza.WAF
	if crsMode != CRSModeOff {
		crsCallback := onCRSMatch
		if crsCallback == nil {
			if crsMode == CRSModeDetect {
				// Default detect mode: leave the engine error callback nil so
				// nothing logs per rule on the request goroutine, and instead
				// aggregate the transaction's matches after processing.
				aggregateCRSLog = true
			} else {
				crsCallback = logCRSMatch
			}
		}
		cw, crsErr := newCRSWAF(paranoiaLevel, crsMode == CRSModeBlock, crsCallback)
		if crsErr != nil {
			slog.Error("waf: failed to load OWASP CRS, continuing with inline rules only", "error", crsErr)
		} else {
			crsWAF = cw
		}
	}
	return crsWAF, aggregateCRSLog
}

// wafInlineRequestHeaders feeds the connection, URI and request headers into
// the inline engine and runs its phase 1. A non-nil interruption means the
// request must be blocked.
func wafInlineRequestHeaders(tx types.Transaction, r *http.Request) *types.Interruption {
	tx.ProcessConnection(r.RemoteAddr, 0, "", 0)
	tx.ProcessURI(r.URL.String(), r.Method, r.Proto)
	for name, values := range r.Header {
		for _, value := range values {
			tx.AddRequestHeader(name, value)
		}
	}
	return tx.ProcessRequestHeaders()
}

// wafCRSRequestHeaders feeds the connection, URI and request headers into the
// CRS engine and runs its phase 1. A non-nil interruption means the request
// must be blocked.
func wafCRSRequestHeaders(crsTx types.Transaction, r *http.Request) *types.Interruption {
	crsTx.ProcessConnection(r.RemoteAddr, 0, "", 0)
	crsTx.ProcessURI(r.URL.String(), r.Method, r.Proto)
	for name, values := range r.Header {
		for _, value := range values {
			crsTx.AddRequestHeader(name, value)
		}
	}
	// net/http promotes Host and Transfer-Encoding out of
	// r.Header; re-add them like the official coraza http
	// connector does, otherwise CRS rule 920280 ("Request
	// Missing a Host Header", anomaly score 5) fires on every
	// request. The inline engine is left as-is on purpose — its
	// rules never look at these headers and its behavior is
	// pinned by tests.
	if r.Host != "" {
		crsTx.AddRequestHeader("Host", r.Host)
		crsTx.SetServerName(r.Host)
	}
	for _, te := range r.TransferEncoding {
		crsTx.AddRequestHeader("Transfer-Encoding", te)
	}
	return crsTx.ProcessRequestHeaders()
}

// wafFeedCRSBody mirrors the inline engine's buffered request body into the
// CRS engine so the body is only read from the wire once. A non-nil
// interruption means the request must be blocked.
func wafFeedCRSBody(tx, crsTx types.Transaction) *types.Interruption {
	if reader, err := tx.RequestBodyReader(); err == nil && reader != nil {
		if it, _, err := crsTx.ReadRequestBodyFrom(reader); it != nil {
			return it
		} else if err != nil {
			slog.Debug("waf: error reading CRS request body", "error", err)
		}
	}
	return nil
}

// wafInspectRequestBody buffers the request body through the inline engine,
// runs its phase 2, mirrors the buffer into the CRS engine and hands the
// buffered body to the downstream handler. A non-nil interruption means the
// request must be blocked.
func wafInspectRequestBody(r *http.Request, tx, crsTx types.Transaction) *types.Interruption {
	it, written, err := tx.ReadRequestBodyFrom(r.Body)
	if it != nil {
		return it
	} else if err != nil {
		slog.Debug("waf: error reading request body", "error", err)
	}

	if it, err := tx.ProcessRequestBody(); it != nil {
		return it
	} else if err != nil {
		slog.Debug("waf: error processing request body", "error", err)
	}

	// Feed the CRS engine from the inline engine's buffer so the
	// body is only read from the wire once. written == 0 means the
	// inline engine skipped buffering (requestBodyAccess turned
	// off for this route, e.g. uploads) — the CRS engine excludes
	// those routes too, so skip it as well and leave r.Body alone.
	if written > 0 {
		if crsTx != nil {
			if it := wafFeedCRSBody(tx, crsTx); it != nil {
				return it
			}
		}

		// Replace body with buffered version so downstream handlers
		// can read it. Only done when the inline engine actually
		// buffered the body — replacing unconditionally would hand
		// routes with body inspection disabled (uploads) an empty
		// reader instead of the original stream.
		reader, err := tx.RequestBodyReader()
		if err == nil && reader != nil {
			r.Body = io.NopCloser(reader)
		}
	}
	return nil
}

// newWAFMiddleware is the implementation behind NewWAFMiddlewareCRS.
// onCRSMatch overrides the CRS match logger (used by tests to observe
// detect-mode matches); nil means log via slog.
func newWAFMiddleware(paranoiaLevel int, crsMode string, onCRSMatch func(types.MatchedRule)) func(http.Handler) http.Handler {
	if paranoiaLevel < 1 || paranoiaLevel > 4 {
		paranoiaLevel = 2
	}
	crsMode = normalizeCRSMode(crsMode)

	waf, err := wafInlineEngine(paranoiaLevel)
	if err != nil {
		slog.Error("waf: failed to create WAF engine, continuing without WAF", "error", err)
		return func(next http.Handler) http.Handler { return next }
	}

	crsWAF, aggregateCRSLog := wafCRSEngine(paranoiaLevel, crsMode, onCRSMatch)

	slog.Info("waf: Coraza WAF enabled", "paranoia_level", paranoiaLevel, "crs_mode", crsMode)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tx := waf.NewTransaction()
			defer func() {
				tx.ProcessLogging()
				if err := tx.Close(); err != nil {
					slog.Debug("waf: error closing transaction", "error", err)
				}
			}()

			var crsTx types.Transaction
			if crsWAF != nil {
				crsTx = crsWAF.NewTransaction()
				defer func() {
					// One aggregated match log per request (detect-mode
					// default only); reads per-request transaction state, so
					// it must run before the transaction is closed.
					if aggregateCRSLog {
						logCRSMatchesAggregate(crsTx)
					}
					crsTx.ProcessLogging()
					if err := crsTx.Close(); err != nil {
						slog.Debug("waf: error closing CRS transaction", "error", err)
					}
				}()
			}

			// Process request headers
			if it := wafInlineRequestHeaders(tx, r); it != nil {
				handleWAFInterruption(w, it)
				return
			}

			// CRS phase 1. In detect mode the engine never interrupts, so the
			// returned interruption is only non-nil in block mode.
			if crsTx != nil {
				if it := wafCRSRequestHeaders(crsTx, r); it != nil {
					handleWAFInterruption(w, it)
					return
				}
			}

			// Process request body (if applicable). Use ContentLength != 0 so
			// chunked requests (Transfer-Encoding: chunked → ContentLength == -1)
			// are inspected too; otherwise the SQLi/XSS/RCE body rules are silently
			// skipped for them. The read is bounded by SecRequestBodyLimit inside
			// Coraza. ContentLength == 0 (no body) still skips inspection.
			if r.Body != nil && r.ContentLength != 0 {
				if it := wafInspectRequestBody(r, tx, crsTx); it != nil {
					handleWAFInterruption(w, it)
					return
				}
			}

			// CRS phase 2 always runs, even without a body: CRS request rules
			// (including query-string XSS/SQLi and the anomaly-blocking
			// evaluation) are phase 2 rules. The inline engine deliberately
			// keeps its original behavior of only running phase 2 when a body
			// is present.
			if crsTx != nil {
				if it, err := crsTx.ProcessRequestBody(); it != nil {
					handleWAFInterruption(w, it)
					return
				} else if err != nil {
					slog.Debug("waf: error processing CRS request body", "error", err)
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func handleWAFInterruption(w http.ResponseWriter, it *types.Interruption) {
	slog.Warn("waf: request blocked",
		"status", it.Status,
		"action", it.Action,
		"rule_id", it.RuleID,
	)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(it.Status)
	_, _ = fmt.Fprintf(w, `{"error":"request blocked by security rules"}`)
}
