package app

import (
	"bytes"
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"go.uber.org/goleak"
)

// TestApp_MalformedTOTPKeyFailsNamedStage pins WP 5.6f: a malformed
// OWNCORD_TOTP_KEY stops boot at the totp-key stage — named in the error and
// before the hub, LiveKit or any listener exists — instead of panicking later
// inside api.NewRouter.
func TestApp_MalformedTOTPKeyFailsNamedStage(t *testing.T) {
	leakOpt := goleak.IgnoreCurrent()
	port := freePort(t)
	a := bootTestApp(t, strconv.Itoa(port), "")
	t.Setenv("OWNCORD_TOTP_KEY", "zz")

	err := a.Run(context.Background())
	if err == nil {
		t.Fatal("Run() = nil, want a boot failure for the malformed OWNCORD_TOTP_KEY")
	}
	if !strings.Contains(err.Error(), "starting totp-key:") {
		t.Errorf("Run() = %v, want an error containing %q", err, "starting totp-key:")
	}
	if a.hub != nil {
		t.Error("the hub was built before the totp-key stage failed")
	}
	assertReleased(t, a, port, leakOpt)
}

// TestApp_TOTPKeyGeneratedOnce pins the generate-once contract: a missing
// key file is created at <data dir>/totp.key with mode 0600, and a second
// load reads the same bytes back rather than regenerating.
func TestApp_TOTPKeyGeneratedOnce(t *testing.T) {
	a := bootTestApp(t, "0", "")
	mustDo(t, "startDataDir", a.startDataDir())
	path := filepath.Join(a.cfg.Server.DataDir, "totp.key")
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("%s exists before the stage ran", path)
	}

	mustDo(t, "startTOTPKey (generate)", a.startTOTPKey())
	first := a.totpKey
	if len(first) != 32 {
		t.Fatalf("generated key is %d bytes, want 32", len(first))
	}
	info, err := os.Stat(path)
	mustDo(t, "key file not written", err)
	if got := info.Mode().Perm(); got != 0o600 && runtime.GOOS != "windows" {
		t.Errorf("key file mode = %v, want 0600", got)
	}
	onDisk, err := os.ReadFile(path)
	mustDo(t, "read key file", err)
	if want := hex.EncodeToString(first); string(onDisk) != want {
		t.Errorf("key file does not hold the loaded key")
	}

	a.totpKey = nil
	mustDo(t, "startTOTPKey (reload)", a.startTOTPKey())
	if !bytes.Equal(first, a.totpKey) {
		t.Error("second load returned a different key: it was regenerated, orphaning every stored TOTP secret")
	}
}
