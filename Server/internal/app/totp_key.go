package app

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
)

// startTOTPKey loads (or generates, on a confirmed absence) the AES-256 key
// that encrypts stored TOTP secrets. It was loaded inside
// api.NewRouter, which panicked on a malformed OWNCORD_TOTP_KEY or a corrupt
// totp.key after the hub and LiveKit were already running; as a stage the same
// failure surfaces as `starting totp-key: ...` before either exists. The
// loader is auth.LoadOrGenerateTOTPKey, unchanged: same environment variable,
// same <data dir>/totp.key, same mode, same fail-closed rules.
// startHub hands the key to StartRuntime, which builds the AuthService.
func (a *App) startTOTPKey() error {
	key, err := auth.LoadOrGenerateTOTPKey(a.cfg.Server.DataDir)
	if err != nil {
		return fmt.Errorf("TOTP encryption key: %w", err)
	}
	a.totpKey = key
	return nil
}
