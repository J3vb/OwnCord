// Package admin provides the embedded admin panel static file server and the
// admin REST API for the OwnCord server.
package admin

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/updater"
)

//go:embed static
var staticFiles embed.FS

// NewHandler returns an http.Handler that serves both the admin REST API and
// the embedded admin panel static files.
//
// Routes:
//
//	/api/*  — admin REST API (all require a moderation permission; see NewAdminAPI)
//	/*      — embedded static files (SPA; index.html for unknown paths)
func NewHandler(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, permInvalidator PermissionInvalidator, mod *service.ModerationService, roles *service.RoleService, opts ...SetupOptions) http.Handler {
	r := chi.NewRouter()

	// Admin REST API mounted at /api
	r.Mount("/api", NewAdminAPI(database, version, hub, u, logBuf, allowedOrigins, permInvalidator, mod, roles, opts...))

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
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
		_, _ = w.Write(indexHTML)
	})
	r.Handle("/*", http.FileServer(http.FS(staticFS)))

	return r
}
