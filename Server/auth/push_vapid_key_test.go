package auth

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestPushVAPIDKey_IsGeneratedOnceAndStable pins the same fail-closed
// contract the TOTP and erasure keys have: two loads from one data
// directory return the same key (generated once, then loaded), and a
// corrupt file on disk is an error rather than a silently regenerated key.
func TestPushVAPIDKey_IsGeneratedOnceAndStable(t *testing.T) {
	t.Setenv("OWNCORD_PUSH_VAPID_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")

	first, err := LoadOrGeneratePushVAPIDKey(dataDir)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	second, err := LoadOrGeneratePushVAPIDKey(dataDir)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if !bytes.Equal(first.PublicKey().Bytes(), second.PublicKey().Bytes()) {
		t.Fatal("second load returned a different key; the generate-once contract broke")
	}

	// A corrupt file must fail closed rather than being replaced with a new
	// key (OC-0321's rule, same as TestLoadOrGenerateErasureKey_EnvAndFailClosed).
	keyPath := filepath.Join(dataDir, "push_vapid.key")
	if err := os.WriteFile(keyPath, []byte("not hex"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrGeneratePushVAPIDKey(dataDir); err == nil {
		t.Error("corrupt push_vapid.key was accepted (or silently replaced)")
	}
	onDisk, err := os.ReadFile(keyPath)
	if err != nil || string(onDisk) != "not hex" {
		t.Errorf("push_vapid.key changed after a failed load: %q, %v", onDisk, err)
	}
}
