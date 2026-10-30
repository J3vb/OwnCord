// Package webclient embeds the browser client bundle the server hosts when
// server.browser_client_enabled is on.
//
// The committed dist/ holds only PLACEHOLDER.txt, so a plain `go build` works
// without npm and the binary carries no client. Release builds copy
// Client/dist-web/ into dist/ before building.
package webclient

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Assets returns the bundle rooted at its index.html, and whether this build
// carries one. Without a dist/index.html it reports false.
func Assets() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	return sub, HasIndex(sub)
}

// HasIndex reports whether fsys is a bundle: a regular index.html at its root.
func HasIndex(fsys fs.FS) bool {
	if fsys == nil {
		return false
	}
	info, err := fs.Stat(fsys, "index.html")
	return err == nil && info.Mode().IsRegular()
}
