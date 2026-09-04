package invariants

import (
	"go/ast"
	"go/token"
	"slices"
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
	// Sites are the functions in the file that may reach out — a receiver
	// method as "(*T).Name", package-level declarations as "(file scope)".
	// A hit anywhere else in the file is a violation, so a new dial added
	// to a listed file has to be inventoried too.
	Sites []string
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
		"release metadata only; the optional github.token rides along for rate limits",
		[]string{"NewUpdater", "(*Updater).fetchLatestRelease"}},
	"updater/download.go": {"manual", "github.com release assets", "an admin applying an update",
		"downloads the pinned, checksum-verified server binary",
		[]string{"(*Updater).downloadFile"}},
	"ws/livekit_download.go": {"config", "github.com/livekit/livekit release assets", "voice.auto_download_livekit (compiled default false; the generated config sets true) with voice.livekit_binary unset",
		"downloads the pinned, checksum-verified livekit-server binary once",
		[]string{"fetchLimited", "downloadTo"}},
	"ws/livekit.go": {"config", "voice.livekit_url (ws://localhost:7880 by default; a remote LiveKit when the operator points it there)", "voice.livekit_url",
		"the room-service client behind RemoveParticipant, GetParticipant, MutePublishedTrack, ListParticipants and ListRooms; the SDK builds its own *http.Client, so only its construction is syntactically visible here",
		[]string{"NewLiveKitClient"}},
	"ws/livekit_process.go": {"config", "voice.livekit_url (ws://localhost:7880 by default; a remote LiveKit when the operator points it there)", "voice.livekit_url",
		"health probes of the LiveKit process; loopback under the default, the operator's LiveKit host otherwise",
		[]string{"NewLiveKitProcess", "(*LiveKitProcess).HealthCheck"}},
	"api/livekit_proxy.go": {"config", "voice.livekit_url (ws://localhost:7880 by default; a remote LiveKit when the operator points it there)", "voice.livekit_url; only while a signed-in client holds a voice session",
		"proxies a connected client's LiveKit signalling socket to the configured LiveKit; that signalling leaves the machine when the URL is remote",
		[]string{"proxyWebSocket"}},
	"updater/assets.go": {"manual", "api.github.com and github.com release assets (github.owner/github.repo)", "an admin's update check or apply, or a client asking /api/v1/client-update",
		"release metadata and asset fetches for the two rows above; refuses any other host",
		[]string{"(*Updater).fetchBody"}},
	// B5-1 moved the dialing out of api/gif_handler.go and
	// plugin/host_http.go and into Server/safefetch, so both of those rows
	// are gone and these two carry what they used to. Neither file chooses a
	// destination: safefetch has no configuration and no call sites of its
	// own, and its gate is whichever caller asked. The callers' own gates are
	// unchanged — gif.api_key (default empty = the route is not mounted) for
	// the GIF proxy, plugins.http_allowlist (default empty = every host
	// denied) for the plugin http capability — so the compiled defaults still
	// reach nowhere.
	"safefetch/policy.go": {"config", "only a destination a caller passed in, and only an address ClassifyAddr accepted", "the caller's gate: gif.api_key, or plugins.http_allowlist",
		"the shared client, transport and dialer; Fetcher.dial connects to the addresses the destination check vetted and to nothing else",
		[]string{"New", "defaultDial"}},
	"safefetch/fetch.go": {"config", "the same, one redirect hop at a time", "the caller's gate: gif.api_key, or plugins.http_allowlist",
		"one bounded request per hop, under the deadline, byte ceilings and content-type allowlist in docs/trust-model.md's C-09 contract",
		[]string{"(*Fetcher).roundTrip"}},
	"internal/app/healthcheck.go": {"loopback", "this server's /health", "the --healthcheck CLI flag",
		"container orchestrators' liveness probe",
		[]string{"RunHealthcheckCLI"}},
	"telemetry/telemetry_otel.go": {"config", "telemetry.otlp_endpoint", "-tags otel build with telemetry.enabled and exporter: otlp",
		"OpenTelemetry export; absent from the default build",
		[]string{"(file scope)"}},
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
	"github.com/livekit/server-sdk-go/v2": {
		calls: map[string]bool{"NewRoomServiceClient": true},
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
		entry, listed := EgressAllow[rel]
		var out []Violation
		for _, h := range hits {
			if listed && slices.Contains(entry.Sites, h.site) {
				continue
			}
			where := rel + " is not in the B4-8 egress inventory"
			if listed {
				where = h.site + " is not one of " + rel + "'s inventoried sites"
			}
			out = append(out, Violation{
				Rule: egressSitesID,
				File: rel,
				Line: h.line,
				Msg: h.what + " opens an outbound network path, and " + where + " " +
					"(invariants.EgressAllow, docs/architecture/diagnostics.md). OwnCord sends no automatic telemetry " +
					"(BPR-055): every outbound path is manual, configuration-gated or loopback, and listed with its " +
					"trigger, gate and site. Add the row or the site — or route the call through an existing one.",
			})
		}
		return out
	},
}

type egressHit struct {
	line int
	what string
	site string // the enclosing function, or "(file scope)"
}

// egressSite names the function declaration enclosing line: "Name",
// "(*T).Name" or "T.Name" for methods, "(file scope)" outside any.
func egressSite(f *ast.File, fset *token.FileSet, line int) string {
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || line < fset.Position(fd.Pos()).Line || line > fset.Position(fd.End()).Line {
			continue
		}
		name := fd.Name.Name
		if fd.Recv != nil && len(fd.Recv.List) > 0 {
			if star, ok := fd.Recv.List[0].Type.(*ast.StarExpr); ok {
				if id := receiverIdent(star.X); id != "" {
					return "(*" + id + ")." + name
				}
			} else if id := receiverIdent(fd.Recv.List[0].Type); id != "" {
				return id + "." + name
			}
		}
		return name
	}
	return "(file scope)"
}

// receiverIdent is the receiver's type name with any generic instantiation
// stripped: T, T[K] and T[K, V] all name T.
func receiverIdent(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.IndexExpr:
		return receiverIdent(x.X)
	case *ast.IndexListExpr:
		return receiverIdent(x.X)
	}
	return ""
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
				hits = append(hits, egressHit{line: fset.Position(imp.Pos()).Line, what: "import " + path})
			}
		}
	}
	for importPath, spec := range egressPackages {
		names, dots := importNames(f, importPath)
		for _, d := range dots {
			hits = append(hits, egressHit{line: fset.Position(d.Pos()).Line, what: "dot-import of " + importPath})
		}
		if len(names) == 0 {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				if pkg, sym, ok := selector(x.Fun); ok && names[pkg] && spec.calls[sym] {
					hits = append(hits, egressHit{line: fset.Position(x.Pos()).Line, what: pkg + "." + sym + "()"})
				}
			case *ast.CompositeLit:
				if pkg, sym, ok := selector(x.Type); ok && names[pkg] && spec.literals[sym] {
					hits = append(hits, egressHit{line: fset.Position(x.Pos()).Line, what: pkg + "." + sym + "{}"})
				}
			}
			return true
		})
	}
	for i := range hits {
		hits[i].site = egressSite(f, fset, hits[i].line)
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
