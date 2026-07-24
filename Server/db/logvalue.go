package db

import "log/slog"

// This file makes the secret-bearing domain types safe to log by construction.
// User.PasswordHash / User.TOTPSecret and Session.TokenHash are json:"-", but
// that only guards JSON responses — slog renders struct fields regardless. By
// implementing slog.LogValuer, logging a *db.User or *db.Session (e.g.
// slog.Info("x", "user", user)) never emits the credential. Secret fields are
// omitted entirely; the useful identifying fields stay visible.

// LogValue omits PasswordHash and TOTPSecret. It exposes whether TOTP is
// enabled (not the secret) since that is often what a log line needs.
func (u User) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int64("id", u.ID),
		slog.String("username", u.Username),
		slog.Int64("role_id", u.RoleID),
		slog.String("status", u.Status),
		slog.Bool("banned", u.Banned),
		slog.Bool("totp_enabled", u.TOTPSecret != nil),
	)
}

// LogValue omits TokenHash (the session-identifying secret).
func (s Session) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int64("id", s.ID),
		slog.Int64("user_id", s.UserID),
		slog.String("device", s.Device),
		slog.String("ip", s.IP),
		slog.String("expires_at", s.ExpiresAt),
	)
}
