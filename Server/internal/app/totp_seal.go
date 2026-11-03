package app

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// totpSealBudget bounds the startup conversion; it touches one row per
// enrolled user, so it finishes in milliseconds on any real install.
const totpSealBudget = 30 * time.Second

// startTOTPSecrets seals, under the key the totp-key stage loaded, every
// stored TOTP secret still kept unsealed from before encryption at rest. It
// runs on every start, after the migrations and before anything serves, so a
// restored older backup is converted too. A store error stops the boot: the
// pass is idempotent and the next start resumes it.
func (a *App) startTOTPSecrets() error {
	ctx, cancel := context.WithTimeout(context.Background(), totpSealBudget)
	defer cancel()
	sealed, unreadable, err := service.SealLegacyTOTPSecrets(ctx, a.database, a.totpKey)
	if err != nil {
		return fmt.Errorf("sealing stored TOTP secrets: %w", err)
	}
	if sealed > 0 {
		a.log.Info("stored TOTP secrets sealed", "count", sealed)
	}
	if unreadable > 0 {
		a.log.Warn("stored TOTP secrets unreadable", "count", unreadable,
			"advice", "check OWNCORD_TOTP_KEY or totp.key: these users cannot finish a two-factor sign-in")
	}
	return nil
}
