package app

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// totpSealBudget bounds the startup conversion, one row per enrolled user.
const totpSealBudget = 30 * time.Second

// startTOTPSecrets seals every stored TOTP secret still unsealed from before
// encryption at rest. A store error stops the boot; the pass is idempotent. Runs after migrations and before
// anything serves, so a restored older backup is converted too.
func (a *App) startTOTPSecrets() error {
	// Not Run's context: cancelling it stops serving, not a start stage; the pass has its own budget.
	ctx, cancel := context.WithTimeout(context.Background(), totpSealBudget)
	defer cancel()
	sealed, unreadable, err := service.SealLegacyTOTPSecrets(ctx, a.database, a.totpKey)
	if err != nil {
		return fmt.Errorf("sealing stored TOTP secrets: %w", err)
	}
	if sealed > 0 {
		a.log.Info("stored TOTP secrets sealed", "count", sealed)
	}
	if len(unreadable) > 0 {
		a.log.Warn("stored TOTP secrets unreadable", "count", len(unreadable), "user_ids", unreadable,
			"advice", "check OWNCORD_TOTP_KEY or totp.key: these users cannot finish a two-factor sign-in")
	}
	return nil
}
