package invariants

import (
	"go/ast"
	"go/token"
	"strconv"
	"strings"
)

// egressSitesID is the rule's stable id.
const egressSitesID = "egress-sites"

// EgressEntry is one row of the B4-8 egress inventory (BPR-055): why a
// production file may open an outbound network connection, what triggers
// it, where it goes, and the configuration that gates it. docs/architecture/
// diagnostics.md is the prose form of this map — keep the two in step.
type EgressEntry struct {
	// Trigger is what makes the code run: "manual" (an admin or user acts),
	// "config" (only when an operator sets the named key), or "loopback"
	// (the destination is this machine by construction).
	Trigger     string
	Destination string
	Gate        string
	Note        string
}

// EgressAllow is the inventory. A production file that constructs an
// outbound client, request or dial and is not listed here fails
// egress-sites; a listed file that stops doing so fails TestEgressAllowIsLive.
// Nothing here runs on its own with the compiled defaults: every row is
// manual, configuration-gated or loopback — which is what "no automatic
// telemetry" means at the code level, and what the runtime capture in
// internal/app (TestNoAutomaticTelemetry_Capture) checks at the wire.
var EgressAllow = map[string]EgressEntry{
	"updater/updater.go": {"manual", "api.github.com (github.owner/github.repo releases)", "an admin's update check, or a client asking /api/v1/client-update",
		"release metadata only; the optional github.token rides along for rate limits"},
	"updater/download.go": {"manual", "github.com release assets", "an admin applying an update",
		"downloads the pinned, checksum-verified server binary"},
	"ws/livekit_download.go": {"config", "github.com/livekit/livekit release assets", "voice.auto_download_livekit (compiled default false; the generated config sets true) with voice.livekit_binary unset",
		"downloads the pinned, checksum-verified livekit-server binary once"},
	"ws/livekit_process.go": {"loopback", "voice.livekit_url (ws://localhost:7880 by default)", "voice.livekit_url",
		"health probes of the companion LiveKit process"},
	"api/livekit_proxy.go": {"loopback", "voice.livekit_url (ws://localhost:7880 by default)", "voice.livekit_url; only while a signed-in client holds a voice session",
		"proxies a connected client's LiveKit signalling socket to the companion process"},
	"updater/assets.go": {"manual", "api.github.com and github.com release assets (github.owner/github.repo)", "an admin's update check or apply, or a client asking /api/v1/client-update",
		"release metadata and asset fetches for the two rows above; refuses any other host"},
	"plugin/host_http.go": {"config", "hosts in plugins.http_allowlist", "plugins.http_allowlist (default empty = no outbound HTTP)",
		"a plugin's host_http capability; SSRF-guarded dialer shared with the GIF proxy"},
	"api/gif_handler.go": {"config", "the GIF provider's API", "gif.api_key (default empty = route not mounted)",
		"proxies a user's GIF search; no key, no route"},
	"internal/app/healthcheck.go": {"loopback", "this server's /health", "the --healthcheck CLI flag",
		"container orchestrators' liveness probe"},
	"telemetry/telemetry_otel.go": {"config", "telemetry.otlp_endpoint", "-tags otel build with telemetry.enabled and exporter: otlp",
		"OpenTelemetry export; absent from the default build"},
}

// egressPackages maps import paths to the selectors that open a connection
// or build something that will. Syntactic on purpose (no type information):
// a file that spells any of these through the package name is an egress
// site whether or not the call is reachable.
var egressPackages = map[string]struct {
	calls    map[string]bool // pkg.Name( ... )
	literals map[string]bool // pkg.Name{ ... }
}{
	"net/http": {
		calls:    map[string]bool{"Get": true, "Post": true, "PostForm": true, "Head": true, "NewRequest": true, "NewRequestWithContext": true},
		literals: map[string]bool{"Client": true, "Transport": true},
	},
	"net": {
		calls:    map[string]bool{"Dial": true, "DialTimeout": true, "DialTCP": true, "DialUDP": true, "DialIP": true, "DialUnix": true},
		literals: map[string]bool{"Dialer": true},
	},
	"crypto/tls": {
		calls: map[string]bool{"Dial": true, "DialWithDialer": true},
	},
	"github.com/coder/websocket": {
		calls: map[string]bool{"Dial": true},
	},
	"google.golang.org/grpc": {
		calls: map[string]bool{"Dial": true, "DialContext": true, "NewClient": true},
	},
}

// egressImportPrefixes are packages whose mere import means the file exports
// somewhere: the OTLP exporters.
var egressImportPrefixes = []string{
	"go.opentelemetry.io/otel/exporters/otlp/",
}

var egressSites = Rule{
	ID: egressSitesID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		hits := egressHits(f, fset)
		if len(hits) == 0 {
			return nil
		}
		if _, ok := EgressAllow[rel]; ok {
			return nil
		}
		var out []Violation
		for _, h := range hits {
			out = append(out, Violation{
				Rule: egressSitesID,
				File: rel,
				Line: h.line,
				Msg: h.what + " opens an outbound network path, and " + rel + " is not in the B4-8 egress inventory " +
					"(invariants.EgressAllow, docs/architecture/diagnostics.md). OwnCord sends no automatic telemetry " +
					"(BPR-055): every outbound path is manual, configuration-gated or loopback, and listed with its " +
					"trigger and gate. Add the row — or route the call through an existing site.",
			})
		}
		return out
	},
}

type egressHit struct {
	line int
	what string
}

// egressHits lists every outbound construct in f: calls and composite
// literals through the egress packages' bound names, and OTLP imports.
func egressHits(f *ast.File, fset *token.FileSet) []egressHit {
	var hits []egressHit
	for _, imp := range f.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		for _, prefix := range egressImportPrefixes {
			if strings.HasPrefix(path, prefix) {
				hits = append(hits, egressHit{fset.Position(imp.Pos()).Line, "import " + path})
			}
		}
	}
	for importPath, spec := range egressPackages {
		names, dots := importNames(f, importPath)
		for _, d := range dots {
			hits = append(hits, egressHit{fset.Position(d.Pos()).Line, "dot-import of " + importPath})
		}
		if len(names) == 0 {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				if pkg, sym, ok := selector(x.Fun); ok && names[pkg] && spec.calls[sym] {
					hits = append(hits, egressHit{fset.Position(x.Pos()).Line, pkg + "." + sym + "()"})
				}
			case *ast.CompositeLit:
				if pkg, sym, ok := selector(x.Type); ok && names[pkg] && spec.literals[sym] {
					hits = append(hits, egressHit{fset.Position(x.Pos()).Line, pkg + "." + sym + "{}"})
				}
			}
			return true
		})
	}
	return hits
}

// selector splits pkg.Sym; ok is false for anything else.
func selector(e ast.Expr) (pkg, sym string, ok bool) {
	sel, isSel := e.(*ast.SelectorExpr)
	if !isSel {
		return "", "", false
	}
	id, isIdent := sel.X.(*ast.Ident)
	if !isIdent {
		return "", "", false
	}
	return id.Name, sel.Sel.Name, true
}
