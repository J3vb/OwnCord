package db_test

import (
	"context"
	"testing"
	"time"
)

// A temporary ban that has already lapsed must not hide a TOTP-less user from
// CountUsersWithoutTOTP: auth.IsEffectivelyBanned treats a lapsed ban_expires
// as "not banned", so a user in this state can still log in. If the count
// query excludes them (banned = 0 filter, ignoring ban_expires), enabling
// require_2fa while they exist silently locks them out with no recovery path
// (see handlers_settings.go's validateRequire2FAUpdate). The query must mirror
// the lapsed-ban arm already used by ListMembers (users.sql) and the API token
// not-banned clause (apitokens.sql).
func TestCountUsersWithoutTOTP_LapsedTempBanStillCounts(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)

	// A user with no TOTP secret and a ban that expired an hour ago.
	lapsedID := seedTokenUser(t, database, "lapsed-ban-no-totp", 3)
	lapsedExpires := time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04:05Z")
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?`, lapsedExpires, lapsedID); err != nil {
		t.Fatalf("seed lapsed ban: %v", err)
	}

	count, err := database.CountUsersWithoutTOTP(ctx)
	if err != nil {
		t.Fatalf("CountUsersWithoutTOTP: %v", err)
	}
	if count != 1 {
		t.Fatalf("CountUsersWithoutTOTP = %d, want 1 (lapsed-ban user without TOTP must still be counted since they can still log in)", count)
	}
}

// A user with an active (not yet expired) ban is genuinely unable to log in,
// so they must stay excluded from the count — enabling require_2fa should not
// be blocked by someone who cannot authenticate anyway.
func TestCountUsersWithoutTOTP_ActiveTempBanExcluded(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)

	activeID := seedTokenUser(t, database, "active-ban-no-totp", 3)
	activeExpires := time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05Z")
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?`, activeExpires, activeID); err != nil {
		t.Fatalf("seed active ban: %v", err)
	}

	count, err := database.CountUsersWithoutTOTP(ctx)
	if err != nil {
		t.Fatalf("CountUsersWithoutTOTP: %v", err)
	}
	if count != 0 {
		t.Fatalf("CountUsersWithoutTOTP = %d, want 0 (actively banned user without TOTP cannot log in and must not block require_2fa)", count)
	}
}
