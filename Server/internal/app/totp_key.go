package app

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
)

// startTOTPKey loads (or generates, on a confirmed absence) the AES-256 key for
// stored TOTP secrets via auth.LoadOrGenerateTOTPKey, failing closed.
func (a *App) startTOTPKey() error {
	key, err := auth.LoadOrGenerateTOTPKey(a.cfg.Server.DataDir)
	if err != nil {
		return fmt.Errorf("TOTP encryption key: %w", err)
	}
	a.totpKey = key
	return nil
}
