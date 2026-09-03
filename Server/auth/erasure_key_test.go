package auth

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadOrGenerateErasureKey_GeneratesOnceThenLoads(t *testing.T) {
	t.Setenv("OWNCORD_ERASURE_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")
	key, err := LoadOrGenerateErasureKey(dataDir)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(key) != erasureKeyBytes {
		t.Fatalf("key length = %d", len(key))
	}
	onDisk, err := os.ReadFile(filepath.Join(dataDir, "erasure.key"))
	if err != nil || string(onDisk) != hex.EncodeToString(key) {
		t.Fatalf("erasure.key = %q, %v; want the generated key", onDisk, err)
	}
	again, err := LoadOrGenerateErasureKey(dataDir)
	if err != nil || hex.EncodeToString(again) != hex.EncodeToString(key) {
		t.Fatalf("second load = %x, %v; want the same key", again, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "erasure.key.tmp")); !os.IsNotExist(err) {
		t.Errorf("temp file left behind: %v", err)
	}
}

func TestLoadOrGenerateErasureKey_EnvAndFailClosed(t *testing.T) {
	want := strings.Repeat("ab", 32)
	t.Setenv("OWNCORD_ERASURE_KEY", want)
	key, err := LoadOrGenerateErasureKey(t.TempDir())
	if err != nil || hex.EncodeToString(key) != want {
		t.Fatalf("env key = %x, %v", key, err)
	}
	t.Setenv("OWNCORD_ERASURE_KEY", "zz")
	if _, err := LoadOrGenerateErasureKey(t.TempDir()); err == nil {
		t.Error("invalid env key accepted")
	}
	t.Setenv("OWNCORD_ERASURE_KEY", "abcd")
	if _, err := LoadOrGenerateErasureKey(t.TempDir()); err == nil {
		t.Error("short env key accepted")
	}

	// A key file that exists but cannot be read must not be replaced.
	t.Setenv("OWNCORD_ERASURE_KEY", "")
	dataDir := t.TempDir()
	keyPath := filepath.Join(dataDir, "erasure.key")
	if err := os.Mkdir(keyPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrGenerateErasureKey(dataDir); err == nil {
		t.Error("a directory at the key path was replaced by a new key")
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("not hex"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrGenerateErasureKey(dataDir); err == nil {
		t.Error("corrupt key file accepted")
	}
	if err := os.Symlink(filepath.Join(dataDir, "missing"), filepath.Join(dataDir, "link.key")); err == nil {
		if err := os.Remove(keyPath); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(filepath.Join(dataDir, "link.key"), keyPath); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadOrGenerateErasureKey(dataDir); err == nil {
			t.Error("dangling symlink at the key path was written through")
		}
	}
}
