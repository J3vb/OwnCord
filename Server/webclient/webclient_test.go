package webclient_test

import (
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/webclient"
)

// The committed tree is the placeholder build: it must report no bundle, or a
// server built without npm would claim to host a client it does not have.
func TestAssets_PlaceholderBuildHasNoBundle(t *testing.T) {
	fsys, ok := webclient.Assets()
	if ok {
		t.Fatal("Assets() reports a bundle in the committed tree; only PLACEHOLDER.txt belongs in dist/")
	}
	if _, err := fs.Stat(fsys, "PLACEHOLDER.txt"); err != nil {
		t.Fatalf("PLACEHOLDER.txt missing from the embedded tree: %v", err)
	}
}

func TestHasIndex(t *testing.T) {
	for _, tc := range []struct {
		name string
		fsys fs.FS
		want bool
	}{
		{"nil", nil, false},
		{"empty", fstest.MapFS{}, false},
		{"index file", fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}}, true},
		{"index is a directory", fstest.MapFS{"index.html/x": {Data: []byte("x")}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := webclient.HasIndex(tc.fsys); got != tc.want {
				t.Errorf("HasIndex = %v, want %v", got, tc.want)
			}
		})
	}
}
