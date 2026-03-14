// Package admin provides the embedded admin panel static file server.
// Full admin API implementation follows in Phase 6.
package admin

import (
	"embed"
	"net/http"
)

//go:embed static
var staticFiles embed.FS

// Handler returns an http.Handler that serves the embedded admin panel static files.
func Handler() http.Handler {
	return http.FileServer(http.FS(staticFiles))
}
