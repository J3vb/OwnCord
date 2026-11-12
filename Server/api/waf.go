// Package api provides the HTTP router and handlers for the OwnCord server.
// waf.go implements the Coraza WAF middleware for OWASP CRS protection (server.waf_enabled, default false).
package api

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/types"
)

// CRS layer modes (server.waf_crs_mode); the inline rules keep blocking in every mode.
const (
	// CRSModeOff disables the OWASP CRS layer entirely.
	CRSModeOff = "off"
	// CRSModeDetect evaluates the full OWASP CRS and logs matches without ever blocking.
	CRSModeDetect = "detect"
	// CRSModeBlock evaluates the CRS in anomaly-scoring blocking mode; enable only after reviewing
	// detect-mode logs.
	CRSModeBlock = "block"
)

// normalizeCRSMode maps a config string to a known mode; empty and unknown values fall back to detect so a
// typo neither disables the CRS layer nor enables blocking.
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

// Both engines' inspect buffer: the global body cap, which is also the largest JSON body a non-exempt route
// reads. A smaller buffer would 413 those routes in the inline engine or let the CRS engine skip the tail
// of their bodies. Every route with a larger cap is exempt from body access in both engines.
const wafRequestBodyLimit = defaultMaxBodySize

// NewWAFMiddlewareCRS creates a Coraza WAF middleware with OWASP CRS rules. paranoiaLevel is 1 (low) to 4
// (paranoid); crsMode is "off" | "detect" | "block" (unknown or empty falls back to detect). It returns nil
// if WAF creation fails (logged; the server continues).
func NewWAFMiddlewareCRS(paranoiaLevel int, crsMode string) func(http.Handler) http.Handler {
	return newWAFMiddleware(paranoiaLevel, crsMode, nil)
}

func wafInlineEngine(paranoiaLevel int) (coraza.WAF, error) {
	return coraza.NewWAF(
		coraza.NewWAFConfig().
			WithDirectives(fmt.Sprintf(`
				SecRuleEngine On
				SecRequestBodyAccess On
				SecResponseBodyAccess Off
				SecRequestBodyLimit %d

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

				# Arguments past SecArgumentsLimit are dropped uninspected; reject
				# the request rather than let them pass unseen. Phase 1 covers
				# the query string; phase 2 covers body arguments.
				SecRule ARGUMENTS_LIMIT_REACHED "@eq 1" \
					"id:900010,phase:1,deny,status:403,log,msg:'Argument limit exceeded'"
				SecRule ARGUMENTS_LIMIT_REACHED "@eq 1" \
					"id:900011,phase:2,deny,status:403,log,msg:'Argument limit exceeded'"

				# Exclude the health endpoint from body inspection. The WebSocket
				# upgrade (/api/v1/ws) needs no exclusion: it carries no body and
				# no query arguments, so these rules have nothing there to match.
				SecRule REQUEST_URI "@streq /api/v1/health" "id:900002,phase:1,pass,nolog,ctl:ruleRemoveById=942100;941100;932100"

				# Exclude file upload endpoint from body inspection (binary content)
				SecRule REQUEST_URI "@beginsWith /api/v1/uploads" "id:900003,phase:1,pass,nolog,ctl:requestBodyAccess=Off"

				# Exclude the other routes with a larger-than-1-MiB app-level
				# cap too (see bodyCapExemptPrefixes in constants.go: 16 MiB
				# plugin installs, 3 MiB avatars, 5 MiB banners). Without this, coraza's
				# default SecRequestBodyLimitAction (Reject) 413s any body
				# that reaches this engine's 1 MiB SecRequestBodyLimit before
				# the app's own, larger limit is ever consulted.
				SecRule REQUEST_URI "@beginsWith /api/v1/admin/plugins/install" "id:900004,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
				SecRule REQUEST_URI "@beginsWith /api/v1/users/me/avatar" "id:900005,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
				SecRule REQUEST_URI "@beginsWith /api/v1/users/me/banner" "id:900007,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
				SecRule REQUEST_URI "@beginsWith /admin/api/discord-imports/upload" "id:900008,phase:1,pass,nolog,ctl:requestBodyAccess=Off"
				SecRule REQUEST_METHOD "@streq POST" "id:900006,phase:1,pass,nolog,chain"
					SecRule REQUEST_URI "@rx ^/api/v1/dms/[0-9]+/icon([?]|$)" "ctl:requestBodyAccess=Off"
			`, wafRequestBodyLimit, paranoiaLevel)),
	)
}

// wafCRSEngine builds the CRS layer, returning the engine (nil when off or failed to load) and whether
// detect-mode logging is aggregated per request.
func wafCRSEngine(paranoiaLevel int, crsMode string, onCRSMatch func(types.MatchedRule)) (coraza.WAF, bool) {
	// A second engine so the inline rules keep their exact blocking behavior in every mode; if it fails to
	// load, the inline engine runs alone. aggregateCRSLog collapses detect-mode logging to one line per
	// request on the default (hot) detect path only; a caller-supplied onCRSMatch (tests) and block mode log
	// per rule.
	aggregateCRSLog := false
	var crsWAF coraza.WAF
	if crsMode != CRSModeOff {
		crsCallback := onCRSMatch
		if crsCallback == nil {
			if crsMode == CRSModeDetect {
				// Default detect mode: leave the engine error callback nil so nothing logs per rule on the
				// request goroutine.
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

func wafCRSRequestHeaders(crsTx types.Transaction, r *http.Request) *types.Interruption {
	crsTx.ProcessConnection(r.RemoteAddr, 0, "", 0)
	crsTx.ProcessURI(r.URL.String(), r.Method, r.Proto)
	for name, values := range r.Header {
		for _, value := range values {
			crsTx.AddRequestHeader(name, value)
		}
	}
	// net/http promotes Host and Transfer-Encoding out of r.Header; re-add them as the coraza http connector
	// does, or CRS rule 920280 fires on every request. The inline engine is left as-is: tests pin its
	// behavior.
	if r.Host != "" {
		crsTx.AddRequestHeader("Host", r.Host)
		crsTx.SetServerName(r.Host)
	}
	for _, te := range r.TransferEncoding {
		crsTx.AddRequestHeader("Transfer-Encoding", te)
	}
	return crsTx.ProcessRequestHeaders()
}

// wafFeedCRSBody mirrors the inline engine's buffered body into the CRS engine so it is read from the wire
// once; a non-nil interruption means block.
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

// wafInspectRequestBody buffers the body through the inline engine, runs its phase 2, mirrors it into the
// CRS engine and hands the buffer downstream. A non-nil interruption means block.
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

	// written == 0 means the inline engine skipped buffering (requestBodyAccess off, e.g. uploads); the CRS
	// engine excludes those routes too, so leave r.Body alone.
	if written > 0 {
		if crsTx != nil {
			if it := wafFeedCRSBody(tx, crsTx); it != nil {
				return it
			}
		}

		// Only when the inline engine buffered: replacing unconditionally would hand upload routes an empty
		// reader.
		reader, err := tx.RequestBodyReader()
		if err == nil && reader != nil {
			r.Body = io.NopCloser(reader)
		}
	}
	return nil
}

// newWAFMiddleware implements NewWAFMiddlewareCRS; onCRSMatch overrides the match logger (tests); nil means
// slog.
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
					// Reads per-request transaction state, so it must run before the transaction is closed.
					if aggregateCRSLog {
						logCRSMatchesAggregate(crsTx)
					}
					crsTx.ProcessLogging()
					if err := crsTx.Close(); err != nil {
						slog.Debug("waf: error closing CRS transaction", "error", err)
					}
				}()
			}

			if it := wafInlineRequestHeaders(tx, r); it != nil {
				handleWAFInterruption(w, it)
				return
			}

			// CRS phase 1; in detect mode the engine never interrupts, so an interruption is only non-nil in
			// block mode.
			if crsTx != nil {
				if it := wafCRSRequestHeaders(crsTx, r); it != nil {
					handleWAFInterruption(w, it)
					return
				}
			}

			// ContentLength != 0 so chunked requests (-1) are inspected too, or the SQLi/XSS/RCE body rules
			// are skipped for them.
			if r.Body != nil && r.ContentLength != 0 {
				if it := wafInspectRequestBody(r, tx, crsTx); it != nil {
					handleWAFInterruption(w, it)
					return
				}
			}

			// CRS phase 2 always runs, even without a body: query-string rules and the anomaly-blocking
			// evaluation are phase 2 rules. The inline engine runs phase 2 only when a body is present.
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
