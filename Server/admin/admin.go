// Package admin provides the embedded admin panel static file server and the
// admin REST API for the OwnCord server.
package admin

import (
	"embed"
	"io/fs"
	"net/http"
	"path"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

//go:embed static
var staticFiles embed.FS

// servedCert and tlsMode (set once by SetServedCertificate) are the served certificate and tls.mode. The
// fingerprint is not a secret (the start-up banner prints it for out-of-band comparison); the dashboard and
// setup finish step surface it so the operator need not watch stderr. In acme mode it is learned on the first
// handshake and follows renewals.
var (
	servedCert = func() auth.ServedCert { return auth.ServedCert{} }
	tlsMode    string
)

// SetServedCertificate installs the TLS mode and served-certificate source. Call once at startup before the
// router serves; a nil served reports none.
func SetServedCertificate(mode string, served func() auth.ServedCert) {
	if served == nil {
		served = func() auth.ServedCert { return auth.ServedCert{} }
	}
	tlsMode, servedCert = mode, served
}

// ServedCertificate is the attention panel's certificate source: TLS mode and served leaf, zero when unknown.
func ServedCertificate() (string, auth.ServedCert) {
	return tlsMode, servedCert()
}

// NewHandler returns an http.Handler serving the admin REST API and the embedded panel static files.
//
// Routes:
//
//	/api/*  — admin REST API (all require a moderation permission; see NewAdminAPI)
//	/*      — embedded static files: index.html, admin.css and js/*.js
func NewHandler(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, permInvalidator PermissionInvalidator, svc *service.Services, opts ...SetupOptions) http.Handler {
	r := chi.NewRouter()

	// Admin REST API mounted at /api. *AdminAPI is not a *chi.Mux, so a
	// NotFound/MethodNotAllowed handler set on r would not reach it.
	r.Mount("/api", NewAdminAPI(database, version, hub, u, logBuf, allowedOrigins, permInvalidator, svc, opts...))

	// Serve the "static" sub-tree of the embedded FS (//go:embed static embeds as "static/…").
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// A programming error (wrong embed path); panic so tests surface it.
		panic("admin: failed to create static sub-FS: " + err.Error())
	}

	// Serve index.html directly for the root path, read once at startup:
	// http.FileServer's redirect behaviour conflicts with chi's Mount prefix
	// stripping.
	indexHTML, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		panic("admin: failed to read index.html: " + err.Error())
	}
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// img-src adds blob: for the Emoji section: /api/v1/emoji/{id}/image needs an Authorization header, which
		// <img src> cannot send, so thumbnails are fetched with the session token and shown as blob: URLs
		// (same-origin, opaque, unreadable across documents; widens nothing an attacker could aim at).
		//
		// script-src is 'self' only: panel scripts are files under static/js and the markup has no inline <script>
		// or on*= handler (controls name a registered handler in data-action), so injected markup cannot run
		// script. style-src keeps 'unsafe-inline' because the markup still carries inline style= attributes.
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'")
		_, _ = w.Write(indexHTML)
	})
	// chi's Mount leaves the /admin prefix on URL.Path, which http.FileServer resolves against, so serve the
	// route's wildcard remainder; a directory answers 404, not a listing.
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "*")
		if info, err := fs.Stat(staticFS, name); err != nil || info.IsDir() {
			http.NotFound(w, req)
			return
		}
		switch path.Ext(name) {
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case ".js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		http.ServeFileFS(w, req, staticFS, name)
	})

	return r
}
