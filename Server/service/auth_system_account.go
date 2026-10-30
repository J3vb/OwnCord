package service

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// refuseSystemAccount refuses a sign-in to the hidden import account, answered
// like a wrong password.
func refuseSystemAccount(user *db.User, ip string) error {
	if !user.IsSystemAccount() {
		return nil
	}
	slog.Warn("login attempt on a system account", "user_id", user.ID, "ip", ip)
	return ErrInvalidCredentials
}
