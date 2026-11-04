package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// fuzzPluginZip builds a zip with one entry per line of names, each holding
// body. A line starting with '@' becomes a symlink entry; "plugin.json" gets
// a valid manifest for "fz" so fuzzing reaches the later install stages.
func fuzzPluginZip(names string, body []byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i, n := range strings.Split(names, "\n") {
		if i >= 16 {
			break
		}
		h := &zip.FileHeader{Name: n, Method: zip.Deflate}
		if rest, ok := strings.CutPrefix(n, "@"); ok {
			h.Name = rest
			h.SetMode(fs.ModeSymlink | 0o777)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			continue
		}
		if strings.HasSuffix(h.Name, "/") {
			continue
		}
		if h.Name == "plugin.json" {
			_, _ = w.Write([]byte(`{"name":"fz","version":"1.0.0","entrypoint":"fz.wasm","permissions":["storage"]}`))
			continue
		}
		_, _ = w.Write(body)
	}
	_ = zw.Close()
	return buf.Bytes()
}

// FuzzInstallFromZip installs archives built from fuzzed entry names, and raw
// fuzzed bytes, into a plugin directory inside a larger root. Whatever the
// archive holds and however the install ends, nothing is written outside the
// plugin directory, no symlink appears inside it, no staging directory is
// left behind, and the installed tree stays within the uncompressed cap.
func FuzzInstallFromZip(f *testing.F) {
	f.Add("plugin.json\nfz.wasm", []byte("\x00asm\x01\x00\x00\x00"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\nassets/a.js\nassets/", []byte("x"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\n../outside.txt", []byte("x"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\nassets/../../outside.txt", []byte("x"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\n/abs.txt", []byte("x"), []byte(nil))
	f.Add("plugin.json\n@fz.wasm", []byte("../../outside"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\n..\\outside.txt", []byte("x"), []byte(nil))
	f.Add("plugin.json\nfz.wasm\nC:\\outside.txt", []byte("x"), []byte(nil))
	f.Add("fz.wasm", []byte("x"), []byte(nil))
	f.Add("", []byte(nil), []byte("PK\x05\x06"+strings.Repeat("\x00", 18)))

	database, err := db.Open(":memory:")
	if err != nil {
		f.Fatalf("db.Open: %v", err)
	}
	f.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		f.Fatalf("db.Migrate: %v", err)
	}
	root := f.TempDir()
	pluginDir := filepath.Join(root, "plugins")
	r, err := NewRegistry(Config{Directory: pluginDir, Store: database})
	if err != nil {
		f.Fatalf("NewRegistry: %v", err)
	}
	f.Cleanup(func() { _ = r.Close(context.Background()) })

	f.Fuzz(func(t *testing.T, names string, body, raw []byte) {
		archives := [][]byte{fuzzPluginZip(names, body)}
		if len(raw) > 0 {
			archives = append(archives, raw)
		}
		for _, b := range archives {
			_, _ = r.InstallFromZip(context.Background(), b)
			fuzzCheckPluginTree(t, root, pluginDir)
		}
	})
}

func fuzzCheckPluginTree(t *testing.T, root, pluginDir string) {
	t.Helper()
	var total int64
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root || p == pluginDir {
			return nil
		}
		rel, relErr := filepath.Rel(pluginDir, p)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Fatalf("install wrote %s, outside the plugin directory", p)
		}
		if d.Type()&fs.ModeSymlink != 0 {
			t.Fatalf("install left a symlink at %s", p)
		}
		if filepath.Dir(p) == pluginDir && strings.HasPrefix(d.Name(), ".install-") {
			t.Fatalf("install left a staging directory %s", p)
		}
		if d.Type().IsRegular() {
			info, infoErr := d.Info()
			if infoErr != nil {
				return infoErr
			}
			total += info.Size()
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("walking %s: %v", root, err)
	}
	if total > maxUncompressedSum {
		t.Fatalf("the plugin directory holds %d bytes, over the %d cap for one install", total, maxUncompressedSum)
	}
}
