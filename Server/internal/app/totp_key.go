package app

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
)

// startTOTPKey loads (or generates, on a confirmed absence) the AES-256 key
// that encrypts stored TOTP secrets, via auth.LoadOrGenerateTOTPKey (the
// OWNCORD_TOTP_KEY variable or <data dir>/totp.key, failing closed). As a stage
// a malformed key surfaces as `starting totp-key: ...` before the hub and
// LiveKit exist. startHub hands the key to StartRuntime, which builds the
// AuthService.
func (a *App) startTOTPKey() error {
	key, err := auth.LoadOrGenerateTOTPKey(a.cfg.Server.DataDir)
	if err != nil {
		return fmt.Errorf("TOTP encryption key: %w", err)
	}
	a.totpKey = key
	return nil
}
