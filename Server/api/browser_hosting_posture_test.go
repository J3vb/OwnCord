package api_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// BG-01's first two closure clauses: the owner opts in to browser-client
// hosting, and the disabled state — which is the default and the only state
// this build has — exposes no app route and no asset. The bundle, its route
// and its own CSP are B8's; this file is the proof that until B8 lands there
// is nothing there, and the proof B8 has to keep green when it mounts one.
//
// Two checkers, because one is not enough. walkBrowserHostingRoutes reads the
// mounted route tree, which is how a FileServer or a Mount would appear.
// probeBrowserHostingWire sends real requests, which is how an SPA index
// fallback would appear — an r.NotFound handler registers no route at all and
// is structurally invisible to a walk. Each has its own negative control.

// browserClientPaths are the paths a hosted browser client answers. The last
// entry is not a browser path: it is the baseline the wire probe assumes, so
// a router that answers everything cannot pass by answering nothing special.
var browserClientPaths = map[string]string{
	"/":                     "the SPA entry point",
	"/index.html":           "the bundle's HTML document",
	"/app":                  "a conventional SPA root",
	"/web":                  "a conventional SPA root",
	"/ui":                   "a conventional SPA root",
	"/client":               "a conventional SPA root",
	"/assets/index.js":      "a Vite-built asset",
	"/static/index.js":      "a webpack-built asset",
	"/favicon.ico":          "a browser client's favicon",
	"/manifest.webmanifest": "a PWA manifest",
	"/service-worker.js":    "a PWA service worker",
	"/zz-unclaimed":         "not a browser path — the baseline: an unclaimed top-level path must 404, or this probe proves nothing",
}

// browserClientPatterns are chi patterns that host a subtree. They need their
// own clause because concretePath rewrites "*" to "x", so "/assets/*" becomes
// "/assets/x" and matches no entry above — and a real Vite bundle is
// hash-named, so the wire probe's "/assets/index.js" would 404 against a
// FileServer rooted there. Neither half sees this shape; together with this
// list they do.
var browserClientPatterns = []string{
	"/*", "/app/*", "/web/*", "/ui/*", "/client/*",
	"/assets/*", "/static/*", "/dist/*", "/public/*",
}

// walkBrowserHostingRoutes walks h's mounted tree and reports every route that
// would host a browser client. It is the checker
// TestBrowserHostingPosture_WalkNegativeControl proves can fail.
func walkBrowserHostingRoutes(t *testing.T, h http.Handler) (total, adminRoutes int, hits []string) {
	t.Helper()
	routes, ok := h.(chi.Routes)
	if !ok {
		t.Fatalf("router is %T, want a chi.Routes so the mounted tree can be walked", h)
	}
	seen := map[string]bool{}
	record := func(key string) {
		if !seen[key] {
			seen[key] = true
			hits = append(hits, key)
		}
	}
	walk := func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		total++
		if strings.HasPrefix(pattern, "/admin/") {
			adminRoutes++
		}
		_, exact := browserClientPaths[pattern]
		_, viaParams := browserClientPaths[concretePath(pattern)]
		if !exact && !viaParams && !slices.Contains(browserClientPatterns, pattern) {
			return nil
		}
		// A subtree mount answers every method; collapse it to one hit.
		key := method + " " + pattern
		if strings.HasSuffix(pattern, "/*") {
			key = "* " + pattern
		}
		record(key)
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	for _, key := range mountedSubtreePatterns(routes, "") {
		record(key)
	}
	slices.Sort(hits)
	return total, adminRoutes, hits
}

// mountedSubtreePatterns reports the mount patterns chi.Walk does not emit.
// Walk descends into a Mount and yields the child routes with the prefix
// applied, never the mount's own "/prefix/*" pattern — so a subrouter that
// declares no route at all and serves everything from its NotFound handler is
// walked as zero routes, and every entry in browserClientPatterns would be
// unreachable for the one shape it most needs to catch.
func mountedSubtreePatterns(routes chi.Routes, parent string) (hits []string) {
	for _, rt := range routes.Routes() {
		if rt.SubRoutes == nil {
			continue
		}
		full := parent + rt.Pattern
		if slices.Contains(browserClientPatterns, full) {
			hits = append(hits, "* "+full)
		}
		hits = append(hits, mountedSubtreePatterns(rt.SubRoutes, parent+strings.TrimSuffix(rt.Pattern, "/*"))...)
	}
	return hits
}

type browserWireHit struct {
	Path        string
	Status      int
	ContentType string
}

// probeBrowserHostingWire asks h for every candidate path and reports any that
// does not answer as an unmounted route. "Unmounted" is 404 AND not HTML: a
// 404 whose body is index.html is exactly how an SPA fallback serves the
// client, and a status-only check passes it.
//
// The HTML test looks at the body as well as the header, and that is not
// belt-and-braces. httptest.ResponseRecorder does no content sniffing, so a
// handler that writes index.html without setting Content-Type leaves the
// header empty here while a real net/http server sniffs the first body chunk
// and answers "text/html; charset=utf-8" — the client would render, and a
// header-only check would call it unmounted. Sniffing also covers a declared
// type that is HTML by another name, such as application/xhtml+xml.
//
// It is the checker TestBrowserHostingPosture_WireProbeNegativeControl proves
// can fail, in all three of its shapes.
func probeBrowserHostingWire(t *testing.T, h http.Handler) []browserWireHit {
	t.Helper()
	paths := make([]string, 0, len(browserClientPaths))
	for p := range browserClientPaths {
		paths = append(paths, p)
	}
	slices.Sort(paths)

	var hits []browserWireHit
	for _, p := range paths {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		ct := strings.ToLower(rec.Header().Get("Content-Type"))
		sniffed := http.DetectContentType(rec.Body.Bytes())
		if rec.Code == http.StatusNotFound && !strings.Contains(ct, "html") && !strings.HasPrefix(sniffed, "text/html") {
			continue
		}
		reported := ct
		if reported == "" {
			reported = "(unset, sniffed " + sniffed + ")"
		}
		hits = append(hits, browserWireHit{Path: p, Status: rec.Code, ContentType: reported})
	}
	return hits
}

// assertWalkedTheRealTree is the vacuity guard both checkers use, in the shape
// absence_contract_test.go established: a walk that saw a stub, an empty mux
// or a wrapper proves nothing, and neither does a probe against one.
func assertWalkedTheRealTree(t *testing.T, total, adminRoutes int) {
	t.Helper()
	if total < 100 {
		t.Fatalf("walked only %d routes; expected the full production router (>= 100)", total)
	}
	if adminRoutes == 0 {
		t.Fatal("walk saw no /admin/ routes; the mounted admin subrouter was not traversed")
	}
}

// TestBrowserHostingPosture_DefaultMountsNoBrowserClientRoute is BG-01 clause
// 2's route half: with the shipped configuration, no route in the production
// tree hosts a browser client.
func TestBrowserHostingPosture_DefaultMountsNoBrowserClientRoute(t *testing.T) {
	total, adminRoutes, hits := walkBrowserHostingRoutes(t, fullRouter(t))
	assertWalkedTheRealTree(t, total, adminRoutes)
	if len(hits) > 0 {
		t.Fatalf("browser-client hosting routes are mounted with the default configuration (BG-01: owner opt-in only):\n  %s",
			strings.Join(hits, "\n  "))
	}
}

// TestBrowserHostingPosture_DefaultServesNoBrowserClientAsset is BG-01 clause
// 2's asset half, checked on the wire rather than in the route table.
func TestBrowserHostingPosture_DefaultServesNoBrowserClientAsset(t *testing.T) {
	h := fullRouter(t)
	// The probe cannot tell a server that hosts nothing from a stub that
	// answers nothing, so it borrows the walk's guard before trusting a
	// clean sweep.
	total, adminRoutes, _ := walkBrowserHostingRoutes(t, h)
	assertWalkedTheRealTree(t, total, adminRoutes)

	hits := probeBrowserHostingWire(t, h)
	if len(hits) == 0 {
		return
	}
	var lines []string
	for _, hit := range hits {
		lines = append(lines, hit.Path+" -> "+http.StatusText(hit.Status)+" ("+hit.ContentType+")")
	}
	t.Fatalf("paths a browser client would occupy do not answer as unmounted routes (BG-01):\n  %s",
		strings.Join(lines, "\n  "))
}

// TestBrowserHostingPosture_WalkNegativeControl proves the walk checker can
// fail, in both of the shapes it has to see: a route registered directly, and
// a Mount — whose own pattern chi.Walk never emits, so only
// mountedSubtreePatterns finds it. Without this, a green walk would prove only
// that the walk ran.
func TestBrowserHostingPosture_WalkNegativeControl(t *testing.T) {
	r := chi.NewRouter()
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir(bundleDir(t)))))
	r.Get("/index.html", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html>"))
	})
	// A Mount whose subrouter declares no route: chi.Walk yields nothing at
	// all for it, so this arm fails unless mountedSubtreePatterns runs.
	sub := chi.NewRouter()
	sub.NotFound(serveIndexHTML)
	r.Mount("/assets", sub)
	r.Mount("/", fullRouter(t))

	total, adminRoutes, hits := walkBrowserHostingRoutes(t, r)
	assertWalkedTheRealTree(t, total, adminRoutes)
	// "* /*" is this test's own wrapper: r.Mount("/", prod) is a root subtree
	// mount, and reporting it is correct — that is the very shape a browser
	// bundle at the root would take. The other three are the probes above.
	want := []string{"* /*", "* /assets/*", "* /static/*", "GET /index.html"}
	if !slices.Equal(hits, want) {
		t.Fatalf("negative control: reported %v, want exactly %v", hits, want)
	}
}

// TestBrowserHostingPosture_WireProbeNegativeControl proves the wire probe can
// fail, once per clause of its rule, against shapes the walk cannot see.
//
// The first three arms are SPA index fallbacks: an r.NotFound handler
// registers no route, so chi.Walk reports nothing, and it answers every
// unclaimed path with the client's HTML under a 404 status. They differ only
// in how the content type reaches the client — declared as text/html, declared
// as xhtml, or not declared at all and left to net/http's sniffing — and all
// three must be caught, because all three render in a browser. The fourth arm
// is a served asset tree, which exercises the other clause: a 200 is not an
// unmounted route whatever its content type.
//
// Each arm also asserts the walk sees nothing, which is the asymmetry that
// justifies having two checkers. If it ever disappears, one of them has
// stopped doing its job.
func TestBrowserHostingPosture_WireProbeNegativeControl(t *testing.T) {
	assets := bundleDir(t)
	for _, tc := range []struct {
		name string
		// wantPaths is nil when the arm answers every candidate path; an
		// asset tree only answers the files it actually holds.
		wantPaths []string
		install   func(chi.Router)
	}{
		{"fallback declares text/html", nil, func(r chi.Router) { r.NotFound(serveIndexHTML) }},
		{"fallback declares xhtml", nil, func(r chi.Router) {
			r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/xhtml+xml")
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("<!doctype html><div id=root>"))
			})
		}},
		{"fallback declares nothing and is sniffed", nil, func(r chi.Router) {
			r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("<!doctype html><div id=root>"))
			})
		}},
		{"asset tree answers 200", []string{"/", "/favicon.ico", "/index.html"}, func(r chi.Router) {
			r.Handle("/*", http.FileServer(http.Dir(assets)))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := chi.NewRouter()
			tc.install(r)

			total, _, walkHits := walkBrowserHostingRoutes(t, r)
			if tc.name == "asset tree answers 200" {
				// This arm is walk-visible by design; it is here for the
				// probe's status clause, not for the asymmetry.
				if !slices.Contains(walkHits, "* /*") {
					t.Fatalf("expected the walk to see the root asset mount, got %v", walkHits)
				}
			} else if total != 0 || len(walkHits) > 0 {
				t.Fatalf("the walk saw %d route(s) and %v; an r.NotFound fallback registers none, so this control is not testing what it claims",
					total, walkHits)
			}

			wireHits := probeBrowserHostingWire(t, r)
			got := make([]string, 0, len(wireHits))
			for _, h := range wireHits {
				got = append(got, h.Path)
			}
			slices.Sort(got)
			want := tc.wantPaths
			if want == nil {
				want = make([]string, 0, len(browserClientPaths))
				for p := range browserClientPaths {
					want = append(want, p)
				}
			}
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Fatalf("negative control: the probe reported %v, want exactly %v", got, want)
			}
		})
	}
}

// serveIndexHTML is the SPA fallback shape a status-only check passes: the
// client's document, served under a 404.
func serveIndexHTML(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte("<!doctype html><div id=root>"))
}

// bundleDir writes the two files a browser bundle always has, so a FileServer
// rooted here answers the probe's candidate paths.
func bundleDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":  "<!doctype html><div id=root>",
		"index.js":    "// bundle",
		"favicon.ico": "\x00\x00\x01\x00",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write probe asset %s: %v", name, err)
		}
	}
	return dir
}

// TestBrowserHostingPosture_PluginAssetHandlerStaysUnmounted pins the second
// half of B5-3's verified premise. (*plugin.Registry).AssetHandler is a
// written, working static-asset handler that production never mounts — the one
// dormant hosting surface in the tree. A route walk would not recognise it
// under a plugin prefix and the wire probe does not know its paths, so the
// only cheap guard is that no production code names it at all.
//
// The scan matches the selector form ".AssetHandler", which catches both a
// call and a method value, and matches neither the declaration (") AssetHandler(")
// nor prose about it in a comment. The declaring file is therefore scanned
// like any other rather than exempted: a mount helper added beside the
// declaration is the likeliest place for one to appear.
func TestBrowserHostingPosture_PluginAssetHandlerStaysUnmounted(t *testing.T) {
	const (
		selector = ".AssetHandler"
		declFile = "plugin/host_ui.go"
		declLine = "func (r *Registry) AssetHandler("
	)

	var files int
	var callers []string
	declSeen := false
	err := filepath.WalkDir("..", func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		files++
		src, readErr := os.ReadFile(path) //nolint:gosec // G304: path from the walk of this module
		if readErr != nil {
			return readErr
		}
		rel := strings.TrimPrefix(filepath.ToSlash(path), "../")
		if rel == declFile && strings.Contains(string(src), declLine) {
			declSeen = true
		}
		if strings.Contains(string(src), selector) {
			callers = append(callers, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk Server/: %v", err)
	}

	// The scan must have run over the real tree and found the declaration,
	// or a silent path change would make this test pass by reading nothing.
	if files < 100 {
		t.Fatalf("scanned only %d non-test .go files; expected the whole Server module (>= 100)", files)
	}
	if !declSeen {
		t.Fatalf("did not find %q in %s; the declaration moved and this scan is no longer looking at it", declLine, declFile)
	}
	if len(callers) > 0 {
		slices.Sort(callers)
		t.Fatalf("(*plugin.Registry).AssetHandler is referenced by production code, so it may now serve assets (BG-01):\n  %s\n"+
			"If mounting it is intended, it is a hosting surface and needs the posture proof above extended to cover it.",
			strings.Join(callers, "\n  "))
	}
}
