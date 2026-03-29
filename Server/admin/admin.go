// Package admin provides the embedded admin panel static file server and the
// admin REST API for the OwnCord server.
package admin

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
)

//go:embed static
var staticFiles embed.FS

// NewHandler returns an http.Handler that serves both the admin REST API and
// the embedded admin panel static files.
//
// Routes:
//
//	/api/*  — admin REST API (all require ADMINISTRATOR permission)
//	/*      — embedded static files (SPA; index.html for unknown paths)
func NewHandler(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer) http.Handler {
	r := chi.NewRouter()

	// Admin REST API mounted at /api
	r.Mount("/api", NewAdminAPI(database, version, hub, u, logBuf))

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
		// Generate a per-request nonce for inline script/style tags,
		// avoiding 'unsafe-inline' in the CSP.
		nonceBytes := make([]byte, 16)
		if _, err := rand.Read(nonceBytes); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		nonce := base64.StdEncoding.EncodeToString(nonceBytes)
		w.Header().Set("Content-Security-Policy",
			fmt.Sprintf("default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-%s'", nonce))
		// Inject nonce into the inline <script> tag.
		nonced := bytes.Replace(indexHTML, []byte("<script>"), []byte("<script nonce=\""+nonce+"\">"), 1)
		_, _ = w.Write(nonced)
	})
	r.Handle("/*", http.FileServer(http.FS(staticFS)))

	return r
}

// Handler returns the admin panel http.Handler using a nil database.
// Deprecated: use NewHandler instead. Kept for backwards-compat with any
// caller that already imported this symbol before Phase 6.
func Handler() http.Handler {
	return http.FileServer(http.FS(staticFiles))
}
