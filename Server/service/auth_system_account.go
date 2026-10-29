package service

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// refuseSystemAccount keeps the hidden import account from ever signing in. Its
// stored password matches nothing, so this is a second lock on the same door,
// answered like a wrong password so the account's existence is not confirmed.
func refuseSystemAccount(user *db.User, ip string) error {
	if !user.IsSystemAccount() {
		return nil
	}
	slog.Warn("login attempt on a system account", "user_id", user.ID, "ip", ip)
	return ErrInvalidCredentials
}
