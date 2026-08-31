package api_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// TestNewRouterRefusesToStartWithMalformedTOTPKey pins OC-0228: a malformed
// OWNCORD_TOTP_KEY (or a corrupt totp.key file) must stop the server from
// coming up rather than let it boot with totpKey == nil. A nil key silently
// breaks every AES call in EncryptTOTPSecret/DecryptTOTPSecret, so every
// 2FA-enabled account — including the owner — would be permanently locked
// out of login (POST /api/v1/auth/verify-totp) and re-enrollment (POST
// /api/v1/users/me/totp/confirm) with a 500, while /health still reports OK.
func TestNewRouterRefusesToStartWithMalformedTOTPKey(t *testing.T) {
	// Not valid hex — auth.LoadOrGenerateTOTPKey returns a hard error for
	// this instead of silently falling back to auto-generation.
	t.Setenv("OWNCORD_TOTP_KEY", "zz")

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name: "Test Server",
			Port: 8443,
			// A real, non-empty data dir — as every production deployment
			// has (config default is "data", and main.go creates it before
			// calling NewRouter) — distinguishes this from the zero-value
			// DataDir used by unrelated handler tests that never touch TOTP
			// crypto and must keep passing.
			DataDir: t.TempDir(),
		},
	}

	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	defer rt.Hub.GracefulStop()

	panicked := false
	func() {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		api.NewRouter(cfg, database, "test", nil, nil, rt)
	}()

	if !panicked {
		t.Fatal("NewRouter did not refuse to start with a malformed OWNCORD_TOTP_KEY; " +
			"it booted with a nil AES key, so verify-totp and totp/confirm would 500 forever")
	}
}
