package auth_test

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// OC-0321 (B4-3): a totp.key that exists but cannot be read is a hard error,
// never a silent regeneration. The wrong-hex and wrong-length branches were
// already pinned by TestLoadOrGenerateTOTPKey_RejectsBadKeyFile; these are
// the read-error branches that used to fall through to generation and
// overwrite the file, orphaning every stored secret.
func TestLoadOrGenerateTOTPKey_ReadErrorFailsClosed(t *testing.T) {
	t.Run("directory at the key path", func(t *testing.T) {
		t.Setenv("OWNCORD_TOTP_KEY", "")
		dataDir := t.TempDir()
		keyPath := filepath.Join(dataDir, "totp.key")
		if err := os.Mkdir(keyPath, 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}

		key, err := auth.LoadOrGenerateTOTPKey(dataDir)
		if err == nil {
			t.Fatalf("LoadOrGenerateTOTPKey generated a key (%x) with a directory at the key path", key)
		}
		if key != nil {
			t.Fatalf("returned key %x alongside an error; want nil", key)
		}
		info, statErr := os.Lstat(keyPath)
		if statErr != nil || !info.IsDir() {
			t.Fatalf("the directory at the key path was replaced (stat: %v, isDir: %v)", statErr, info != nil && info.IsDir())
		}
		if _, err := os.Stat(keyPath + ".tmp"); err == nil {
			t.Fatal("a temp key file was left beside the refused path")
		}
	})

	t.Run("dangling symlink at the key path", func(t *testing.T) {
		t.Setenv("OWNCORD_TOTP_KEY", "")
		dataDir := t.TempDir()
		keyPath := filepath.Join(dataDir, "totp.key")
		if err := os.Symlink(filepath.Join(dataDir, "missing-target"), keyPath); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}

		key, err := auth.LoadOrGenerateTOTPKey(dataDir)
		if err == nil {
			t.Fatalf("LoadOrGenerateTOTPKey generated a key (%x) through a dangling symlink", key)
		}
		// Nothing may have been written through the link.
		if _, err := os.Stat(filepath.Join(dataDir, "missing-target")); err == nil {
			t.Fatal("a key was written through the dangling symlink")
		}
		if info, err := os.Lstat(keyPath); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("the symlink at the key path was replaced (lstat: %v)", err)
		}
	})

	t.Run("unreadable key file", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses file permission bits; the EACCES branch is exercised on the unprivileged CI runner")
		}
		t.Setenv("OWNCORD_TOTP_KEY", "")
		dataDir := t.TempDir()
		keyPath := filepath.Join(dataDir, "totp.key")
		original := []byte(hex.EncodeToString(make([]byte, 32)))
		if err := os.WriteFile(keyPath, original, 0o200); err != nil {
			t.Fatalf("write key: %v", err)
		}

		key, err := auth.LoadOrGenerateTOTPKey(dataDir)
		if err == nil {
			t.Fatalf("LoadOrGenerateTOTPKey generated a key (%x) over an unreadable file", key)
		}
		if err := os.Chmod(keyPath, 0o600); err != nil {
			t.Fatalf("chmod back: %v", err)
		}
		after, readErr := os.ReadFile(keyPath)
		if readErr != nil {
			t.Fatalf("reading key after failure: %v", readErr)
		}
		if !bytes.Equal(after, original) {
			t.Fatalf("the unreadable key file was rewritten to %q", after)
		}
	})
}

// A generated key is written through a temp file and a rename, so a crash
// mid-write cannot leave a truncated totp.key — and a stale temp file from
// such a crash must not block the next start's generation.
func TestLoadOrGenerateTOTPKey_AtomicWrite(t *testing.T) {
	t.Setenv("OWNCORD_TOTP_KEY", "")
	dataDir := t.TempDir()
	keyPath := filepath.Join(dataDir, "totp.key")
	if err := os.WriteFile(keyPath+".tmp", []byte("stale partial write"), 0o600); err != nil {
		t.Fatalf("write stale temp: %v", err)
	}

	key, err := auth.LoadOrGenerateTOTPKey(dataDir)
	if err != nil {
		t.Fatalf("LoadOrGenerateTOTPKey with a stale temp file: %v", err)
	}
	onDisk, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("reading totp.key: %v", err)
	}
	if string(onDisk) != hex.EncodeToString(key) {
		t.Fatalf("totp.key = %q, want the generated key %x", onDisk, key)
	}
	if _, err := os.Stat(keyPath + ".tmp"); err == nil {
		t.Fatal("temp file left behind after a successful write")
	}
}
