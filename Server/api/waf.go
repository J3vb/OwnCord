// Package api provides the HTTP router and handlers for the OwnCord server.
//
// waf.go implements Coraza WAF middleware for OWASP CRS protection.
// Toggle via config: server.waf_enabled (default: false).
package api

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/types"
)

// NewWAFMiddleware creates a Coraza WAF middleware with OWASP CRS rules.
// paranoiaLevel controls rule sensitivity (1=low, 2=default, 3=strict, 4=paranoid).
// Returns nil middleware if WAF creation fails (logged as error, server continues).
func NewWAFMiddleware(paranoiaLevel int) func(http.Handler) http.Handler {
	if paranoiaLevel < 1 || paranoiaLevel > 4 {
		paranoiaLevel = 2
	}

	waf, err := coraza.NewWAF(
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
			`, paranoiaLevel)),
	)
	if err != nil {
		slog.Error("waf: failed to create WAF engine, continuing without WAF", "error", err)
		return func(next http.Handler) http.Handler { return next }
	}

	slog.Info("waf: Coraza WAF enabled", "paranoia_level", paranoiaLevel)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tx := waf.NewTransaction()
			defer func() {
				tx.ProcessLogging()
				if err := tx.Close(); err != nil {
					slog.Debug("waf: error closing transaction", "error", err)
				}
			}()

			// Process request headers
			tx.ProcessConnection(r.RemoteAddr, 0, "", 0)
			tx.ProcessURI(r.URL.String(), r.Method, r.Proto)
			for name, values := range r.Header {
				for _, value := range values {
					tx.AddRequestHeader(name, value)
				}
			}

			if it := tx.ProcessRequestHeaders(); it != nil {
				handleWAFInterruption(w, it)
				return
			}

			// Process request body (if applicable)
			if r.Body != nil && r.ContentLength > 0 {
				if it, _, err := tx.ReadRequestBodyFrom(r.Body); it != nil {
					handleWAFInterruption(w, it)
					return
				} else if err != nil {
					slog.Debug("waf: error reading request body", "error", err)
				}

				if it, err := tx.ProcessRequestBody(); it != nil {
					handleWAFInterruption(w, it)
					return
				} else if err != nil {
					slog.Debug("waf: error processing request body", "error", err)
				}

				// Replace body with buffered version so downstream handlers can read it
				reader, err := tx.RequestBodyReader()
				if err == nil && reader != nil {
					r.Body = io.NopCloser(reader)
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
	fmt.Fprintf(w, `{"error":"request blocked by security rules"}`)
}
