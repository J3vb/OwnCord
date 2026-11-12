// waf_crs.go builds the OWASP Core Rule Set engine for the WAF middleware and
// logs its matches with the query string scrubbed.

package api

import (
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"

	coreruleset "github.com/corazawaf/coraza-coreruleset/v4"
	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/types"
)

// newCRSWAF builds a second Coraza engine with the embedded OWASP Core Rule Set,
// kept apart from the inline-rules engine so those rules keep their test-pinned
// blocking behavior in every CRS mode. Detection-only is the default because
// chat text routinely false-positives the CRS; blocking needs tuning on real
// traffic, while detect mode gives full visibility with no user-facing risk.
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
				SecRule REQUEST_URI "@beginsWith /api/v1/users/me/banner" "id:1005,phase:1,pass,nolog,ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"
				SecRule REQUEST_URI "@beginsWith /admin/api/discord-imports/upload" "id:1006,phase:1,pass,nolog,ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"
				SecRule REQUEST_METHOD "@streq POST" "id:1004,phase:1,pass,nolog,chain"
					SecRule REQUEST_URI "@rx ^/api/v1/dms/[0-9]+/icon([?]|$)" "ctl:requestBodyAccess=Off,ctl:ruleRemoveById=920420"

				Include @owasp_crs/*.conf

				# Engine mode: DetectionOnly logs matches without interrupting;
				# On enforces CRS anomaly-scoring blocking.
				SecRuleEngine %s

				# We never feed response data into this engine (parity with the
				# inline engine), so don't pay for response body buffering.
				SecResponseBodyAccess Off

				# Body limits: match the app's non-upload cap (see
				# wafRequestBodyLimit) instead of the recommended-config
				# 12.5 MiB, and never reject on size — request size
				# enforcement belongs to the app middleware, not the CRS
				# layer. Uploads are excluded from body access above.
				SecRequestBodyLimit %d
				SecRequestBodyLimitAction ProcessPartial

				# Match logging goes through the error callback into slog;
				# don't also emit native audit log records.
				SecAuditEngine Off
			`, paranoiaLevel, engine, wafRequestBodyLimit)),
	)
}

// logURIPath is the request target without its query string, for log lines:
// a query can carry a credential, so only the path is recorded. A target that
// does not parse is cut at the first '?'.
func logURIPath(raw string) string {
	if u, err := url.ParseRequestURI(raw); err == nil {
		return u.EscapedPath()
	}
	path, _, _ := strings.Cut(raw, "?")
	return path
}

var linkQueryValue = regexp.MustCompile(`(?i)(link=)[^&\s"']+`)

func scrubLogQuery(s string) string {
	return linkQueryValue.ReplaceAllString(s, "${1}[removed]")
}

// logCRSMatch is the per-rule CRS match logger, used in block mode (blocked
// requests are rare and per-rule detail is wanted) and when a caller supplies it
// (tests). Default detect mode uses logCRSMatchesAggregate instead.
func logCRSMatch(mr types.MatchedRule) {
	slog.Warn("waf: CRS rule matched",
		"rule_id", mr.Rule().ID(),
		"severity", mr.Rule().Severity().String(),
		"uri", logURIPath(mr.URI()),
		"msg", scrubLogQuery(mr.Message()),
		"data", scrubLogQuery(mr.Data()),
	)
}

// logCRSMatchesAggregate emits at most ONE log line per request that tripped CRS
// rules instead of a Warn per rule: in detect mode ordinary chat prose trips
// several SQLi/XSS rules and anomaly scoring amplifies the count, so per-rule
// logging on the request goroutine is hot-path overhead. It keeps the signal
// (rules matched, highest severity) on one Warn, with the rule-id list at Debug.
// It reads only per-request transaction state.
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
		// Internal bookkeeping rules (this package's setvar/ctl SecActions and
		// CRS setup actions) carry no message and are not detections; the
		// per-rule callback skips them too, so keep them out of the count.
		if mr.Message() == "" {
			continue
		}
		ids = append(ids, mr.Rule().ID())
		// Severity is inverted: 0 (emergency) is the most severe, 7 (debug)
		// the least. The first detection seeds the max; smaller wins after.
		if sev := mr.Rule().Severity(); len(ids) == 1 || sev < topSev {
			topSev = sev
			topRuleID = mr.Rule().ID()
			topURI = logURIPath(mr.URI())
			topMsg = scrubLogQuery(mr.Message())
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
