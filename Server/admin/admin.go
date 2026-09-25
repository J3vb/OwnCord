// Package admin provides the embedded admin panel static file server and the
// admin REST API for the OwnCord server.
package admin

import (
	"embed"
	"io/fs"
	"net/http"
	"path"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

//go:embed static
var staticFiles embed.FS

// leafFingerprint is the served TLS certificate's SHA-256 in the client's pin
// format, set once at startup via SetLeafFingerprint. It is not a secret — it
// is printed in the start-up banner for users to compare out of band — and it
// is empty when there is no statically loaded certificate (TLS off, or ACME
// before its first handshake). The admin dashboard and the setup wizard's
// finish step surface it so the operator does not have to watch stderr.
var leafFingerprint string

// SetLeafFingerprint installs the served certificate's fingerprint for the
// admin panel to surface. Call once at startup, next to SetDatabasePath.
func SetLeafFingerprint(fp string) {
	leafFingerprint = fp
}

// NewHandler returns an http.Handler that serves both the admin REST API and
// the embedded admin panel static files.
//
// Routes:
//
//	/api/*  — admin REST API (all require a moderation permission; see NewAdminAPI)
//	/*      — embedded static files: index.html, admin.css and js/*.js
func NewHandler(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, permInvalidator PermissionInvalidator, svc *service.Services, opts ...SetupOptions) http.Handler {
	r := chi.NewRouter()

	// Admin REST API mounted at /api
	r.Mount("/api", NewAdminAPI(database, version, hub, u, logBuf, allowedOrigins, permInvalidator, svc, opts...))

	// Static files — serve from the "static" sub-tree of the embedded FS.
	// The //go:embed static directive in this package embeds as "static/…",
	// not "admin/static/…", so we strip just "static".
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// This is a programming error (wrong embed path) and should never
		// happen in production. Panic so it surfaces immediately in tests.
		panic("admin: failed to create static sub-FS: " + err.Error())
	}

	// Serve index.html directly for the root path. We read it once at
	// startup instead of using http.FileServer, which has redirect
	// behaviour that conflicts with chi's Mount prefix stripping.
	indexHTML, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		panic("admin: failed to read index.html: " + err.Error())
	}
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// img-src adds blob: for the Emoji section: /api/v1/emoji/{id}/image
		// requires an Authorization header, which <img src> cannot send, so
		// each thumbnail is fetched with the session token and swapped in as a
		// blob: URL. blob: is same-origin, opaque and unreadable across
		// documents — it widens nothing an attacker could aim at.
		//
		// script-src is 'self' only: the panel's scripts are the files under
		// static/js, and its markup carries no inline <script> or on*= handler
		// (controls name a registered handler in data-action instead), so
		// injected markup cannot run script. style-src keeps 'unsafe-inline'
		// because the markup still carries inline style= attributes.
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'")
		_, _ = w.Write(indexHTML)
	})
	// The stylesheet and scripts index.html loads. chi's Mount leaves the
	// /admin prefix on URL.Path, which http.FileServer resolves against, so
	// serve the route's wildcard remainder instead. A directory answers 404
	// rather than a listing.
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
