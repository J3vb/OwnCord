package service

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

func refuseSystemAccount(user *db.User, ip string) error {
	if !user.IsSystemAccount() {
		return nil
	}
	slog.Warn("login attempt on a system account", "user_id", user.ID, "ip", ip)
	return ErrInvalidCredentials
}
