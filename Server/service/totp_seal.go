package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// TOTPSecretStore is what SealLegacyTOTPSecrets needs from the database.
type TOTPSecretStore interface {
	ListUserTOTPSecrets(ctx context.Context) ([]db.UserTOTPSecret, error)
	ReplaceUserTOTPSecret(ctx context.Context, userID int64, old, next string) (bool, error)
}

// SealLegacyTOTPSecrets converts every unsealed stored TOTP secret and counts
// the ones it sealed and the ones that are neither sealed nor usable. Each
// write is a compare-and-set on the value read, so a row an enable or disable
// changed in between is left to that writer.
func SealLegacyTOTPSecrets(ctx context.Context, st TOTPSecretStore, key []byte) (sealed, unreadable int, err error) {
	rows, err := st.ListUserTOTPSecrets(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("listing: %w", err)
	}
	for _, row := range rows {
		next, outcome, sealErr := auth.SealLegacyTOTPSecret(key, row.Stored)
		if sealErr != nil {
			return sealed, unreadable, fmt.Errorf("user %d: %w", row.UserID, sealErr)
		}
		switch outcome {
		case auth.SealAlreadySealed:
		case auth.SealUnreadable:
			unreadable++
		case auth.SealConverted:
			replaced, repErr := st.ReplaceUserTOTPSecret(ctx, row.UserID, row.Stored, next)
			if repErr != nil {
				return sealed, unreadable, fmt.Errorf("user %d: %w", row.UserID, repErr)
			}
			if replaced {
				sealed++
			}
		}
	}
	return sealed, unreadable, nil
}

var _ TOTPSecretStore = (*db.DB)(nil)
