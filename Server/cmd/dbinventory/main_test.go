package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestProductionFilesExemptsOnlyTopLevelLayers pins the walker's exemption to
// the root-relative path: Server/db and Server/service are the layers that
// may import db; a nested directory that shares a name (api/service/) is
// production code above the domain layer and must be inventoried. Tests,
// testdata and hidden directories are skipped at any depth.
func TestProductionFilesExemptsOnlyTopLevelLayers(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{
		"api/w.go",
		"api/w_test.go",
		"api/service/x.go",
		"api/db/y.go",
		"service/y.go",
		"db/z.go",
		"db/dbgen/q.go",
		"ws/testdata/fixture.go",
		".hidden/h.go",
		"main.go",
	} {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("package x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := productionFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api/db/y.go", "api/service/x.go", "api/w.go", "main.go"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("productionFiles = %v, want %v", got, want)
	}
}
