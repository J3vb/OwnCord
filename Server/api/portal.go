package api

import (
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/webclient"
	"github.com/go-chi/chi/v5"
)

// The browser client portal. MountPortal serves exactly two routes:
// the bundle's index.html at GET / and its hashed files under GET /assets/*.
// It adds no NotFound fallback, so every other unclaimed path keeps answering
// the router's plain 404 and an unknown API path is never answered with HTML.
// The router mounts it only when server.browser_client_enabled is on.

// portalNotIncluded is the body of GET / when the binary carries only the
// placeholder bundle.
const portalNotIncluded = "browser client not included in this build\n"

const (
	portalIndexCache = "no-cache"
	portalAssetCache = "public, max-age=31536000, immutable"
	// portalPermissions replaces the global Permissions-Policy on the index
	// document only: the client needs the microphone, camera and screen
	// capture for calls.
	portalPermissions = "camera=(self), microphone=(self), display-capture=(self), geolocation=()"
)

// portalHost matches a Host header that is a plain host name, IPv4 address or
// bracketed IPv6 address with an optional port. Anything else gets no explicit
// wss: source in the policy.
var portalHost = regexp.MustCompile(`^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$`)

// portalCSP is the index document's Content-Security-Policy. It starts from
// the desktop client's policy (Client/src-tauri/tauri.conf.json) without the
// loopback and ipc: sources, and keeps connect-src to this origin.
func portalCSP(host string) string {
	connect := "connect-src 'self'"
	if portalHost.MatchString(host) {
		connect += " wss://" + host
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		connect,
		"img-src 'self' blob: data:",
		"media-src 'self' blob:",
		"font-src 'self'",
		"worker-src 'self' blob:",
		"frame-src https://www.youtube.com https://youtube.com",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

// portalTypes pins the content types a Vite bundle uses, so a host whose OS
// mime table maps .js to text/plain cannot break module loading.
var portalTypes = map[string]string{
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".wasm":        "application/wasm",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".webp":        "image/webp",
	".woff2":       "font/woff2",
	".webmanifest": "application/manifest+json",
	".mp3":         "audio/mpeg",
	".ogg":         "audio/ogg",
}

func portalContentType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := portalTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// MountPortal mounts the portal routes on r, serving from bundle. A nil
// bundle, or one without an index.html, is the placeholder build: GET /
// answers 404 with a one-line note and /assets/* serves nothing. The index
// and every file under assets/ are read once here, so a request never copies
// a file; names with a dot-segment (".vite/", ".DS_Store") are not served.
func MountPortal(r chi.Router, bundle fs.FS) {
	var index []byte
	assets := map[string][]byte{}
	if webclient.HasIndex(bundle) {
		if b, err := fs.ReadFile(bundle, "index.html"); err == nil {
			index = b
			assets = loadPortalAssets(bundle)
		}
	}
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		if index == nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(portalNotIncluded))
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", portalCSP(req.Host))
		h.Set("Permissions-Policy", portalPermissions)
		h.Set("Cache-Control", portalIndexCache)
		_, _ = w.Write(index)
	})
	r.Get("/assets/*", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "*")
		body, ok := assets[name]
		if !ok {
			http.NotFound(w, req)
			return
		}
		h := w.Header()
		h.Set("Content-Type", portalContentType(name))
		h.Set("Cache-Control", portalAssetCache)
		_, _ = w.Write(body)
	})
}

// loadPortalAssets reads every regular file under assets/ into memory, keyed
// by its path below assets/. A file that cannot be read is left out, and a
// walk error stops the walk with what was read so far.
func loadPortalAssets(bundle fs.FS) map[string][]byte {
	assets := map[string][]byte{}
	_ = fs.WalkDir(bundle, "assets", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(p, "assets/")
		if strings.HasPrefix(d.Name(), ".") && p != "assets" {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || strings.Contains(name, `\`) {
			return nil
		}
		if b, readErr := fs.ReadFile(bundle, p); readErr == nil {
			assets[name] = b
		}
		return nil
	})
	return assets
}

// mountBrowserClient mounts the browser client portal, an owner
// opt-in. Off, nothing is mounted at / or /assets/*
// (browser_hosting_posture_test.go). A nil bundle uses the embedded one.
func mountBrowserClient(r chi.Router, cfg *config.Config, bundle fs.FS) {
	if !cfg.Server.BrowserClientEnabled {
		return
	}
	if bundle == nil {
		bundle, _ = webclient.Assets()
	}
	MountPortal(r, bundle)
}

// warnOnBrowserClient reports a browser-client portal that is switched on but
// cannot work as the owner expects. The key is an owner opt-in; with
// it on and no bundle in the binary, GET / answers "not included in this
// build", and with a self-signed certificate every browser shows its own
// warning before the page loads.
func warnOnBrowserClient(cfg *config.Config, bundled bool) {
	if !cfg.Server.BrowserClientEnabled {
		return
	}
	if !bundled {
		slog.Warn("server.browser_client_enabled is set, but this build does not include the browser client — GET / answers 404 until a build that carries it is installed")
	}
	if cfg.TLS.Mode == "self_signed" {
		slog.Warn("server.browser_client_enabled is set with tls.mode self_signed — browsers warn about the certificate before the browser client loads, and phone browsers may refuse it",
			"fix", "use tls.mode acme or manual with a trusted certificate, or a reverse proxy that has one")
	}
}
