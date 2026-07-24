package db

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestUserSessionRedactedInLogs is the security guard for domain-type
// redaction: logging a db.User / db.Session (by value or by pointer) must never
// emit the password hash, TOTP secret, or session token hash.
func TestUserSessionRedactedInLogs(t *testing.T) {
	const (
		pwHash = "PWHASH_should_not_appear"
		totp   = "TOTP_SECRET_should_not_appear"
		token  = "TOKENHASH_should_not_appear"
	)
	totpPtr := totp
	user := User{ID: 7, Username: "alice", PasswordHash: pwHash, TOTPSecret: &totpPtr, RoleID: 2}
	sess := Session{ID: 3, UserID: 7, TokenHash: token, Device: "cli"}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	// Value and pointer paths — both must resolve LogValue.
	log.Info("u", "user", user, "user_ptr", &user)
	log.Info("s", "session", sess, "session_ptr", &sess)

	out := buf.String()
	for _, secret := range []string{pwHash, totp, token} {
		if strings.Contains(out, secret) {
			t.Errorf("secret leaked into log output: %q\n%s", secret, out)
		}
	}
	if !strings.Contains(out, "alice") {
		t.Errorf("expected username in output:\n%s", out)
	}
	if !strings.Contains(out, "totp_enabled=true") {
		t.Errorf("expected totp_enabled flag in output:\n%s", out)
	}
}
