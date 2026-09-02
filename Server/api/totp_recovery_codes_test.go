package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// BPR-046 (B4-3): emergency recovery codes end to end at the API tier —
// issued once at enrolment, accepted in place of a TOTP code, single-use,
// regenerable behind the password, and gone when 2FA is disabled.

const recoveryTestPassword = "Password1!"

type totpEnrolment struct {
	secret      string
	codes       []string
	confirmCode string // spent by the confirm step; the replay window refuses it
}

// enrolWithCodes runs enable + confirm for token and returns the secret the
// authenticator would hold and the recovery codes the enable step showed.
func enrolWithCodes(t *testing.T, router http.Handler, token string) totpEnrolment {
	t.Helper()
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": recoveryTestPassword})
	if rr.Code != http.StatusOK {
		t.Fatalf("enable: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var enable struct {
		QRURI       string   `json:"qr_uri"`
		BackupCodes []string `json:"backup_codes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &enable); err != nil {
		t.Fatalf("decode enable: %v", err)
	}
	uri, err := url.Parse(enable.QRURI)
	if err != nil {
		t.Fatalf("parse otpauth URI: %v", err)
	}
	secret := uri.Query().Get("secret")
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": recoveryTestPassword, "code": code})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("confirm: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	return totpEnrolment{secret: secret, codes: enable.BackupCodes, confirmCode: code}
}

// challenge logs username in and returns the partial-auth token.
func challenge(t *testing.T, router http.Handler, username string) string {
	t.Helper()
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": username, "password": recoveryTestPassword,
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("login: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		PartialToken string `json:"partial_token"`
		Requires2FA  bool   `json:"requires_2fa"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if !resp.Requires2FA || resp.PartialToken == "" {
		t.Fatalf("login did not issue a challenge: %s", rr.Body.String())
	}
	return resp.PartialToken
}

// freshTOTPCode returns a code the ±1-period window accepts now and that is
// not the one the enrolment's confirm step already spent (the replay window
// would refuse that one for the rest of its period).
func freshTOTPCode(t *testing.T, secret, spent string) string {
	t.Helper()
	now := time.Now().UTC()
	for _, offset := range []time.Duration{0, -30 * time.Second, 30 * time.Second} {
		code, err := auth.GenerateTOTPCode(secret, now.Add(offset))
		if err != nil {
			t.Fatalf("GenerateTOTPCode: %v", err)
		}
		if code != spent {
			return code
		}
	}
	t.Fatal("every code in the window equals the spent one")
	return ""
}

func verifyWith(t *testing.T, router http.Handler, partial, code string) (status int, body map[string]any) {
	t.Helper()
	rr := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partial, map[string]string{"code": code})
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	return rr.Code, body
}

func TestRecoveryCodes_EndToEnd(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	token := loginAndGetToken(t, router, database, "recovery-user", 4)

	enr := enrolWithCodes(t, router, token)
	if len(enr.codes) != 10 {
		t.Fatalf("enable returned %d recovery codes, want 10", len(enr.codes))
	}
	for _, c := range enr.codes {
		if len(c) != 11 || c[5] != '-' {
			t.Fatalf("recovery code %q is not shaped XXXXX-XXXXX", c)
		}
	}

	// A recovery code, typed lower-case without its separator, completes the
	// second step and reports the remainder.
	partial := challenge(t, router, "recovery-user")
	typed := strings.ToLower(strings.ReplaceAll(enr.codes[0], "-", ""))
	status, body := verifyWith(t, router, partial, typed)
	if status != http.StatusOK || body["token"] == nil || body["token"] == "" {
		t.Fatalf("verify with a recovery code: status = %d, body = %v", status, body)
	}
	if remaining, _ := body["recovery_codes_remaining"].(float64); remaining != 9 {
		t.Fatalf("recovery_codes_remaining = %v, want 9", body["recovery_codes_remaining"])
	}

	// Single use: the same code is refused on the next challenge, and a TOTP
	// code's success response does not carry the remainder.
	partial = challenge(t, router, "recovery-user")
	if status, body := verifyWith(t, router, partial, enr.codes[0]); status != http.StatusUnauthorized || body["error"] != "UNAUTHORIZED" {
		t.Fatalf("spent recovery code: status = %d, body = %v; want 401 UNAUTHORIZED", status, body)
	}
	totp := freshTOTPCode(t, enr.secret, enr.confirmCode)
	if status, body := verifyWith(t, router, partial, totp); status != http.StatusOK || body["recovery_codes_remaining"] != nil {
		t.Fatalf("TOTP after a refused recovery code: status = %d, body = %v", status, body)
	}

	// Regeneration replaces the set behind the password: an old unused code
	// stops working, a new one works.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/recovery-codes", token,
		map[string]string{"password": "wrong"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("regenerate with a wrong password: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/recovery-codes", token,
		map[string]string{"password": recoveryTestPassword})
	if rr.Code != http.StatusOK {
		t.Fatalf("regenerate: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var regen struct {
		BackupCodes []string `json:"backup_codes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &regen); err != nil {
		t.Fatalf("decode regenerate: %v", err)
	}
	if len(regen.BackupCodes) != 10 || regen.BackupCodes[0] == enr.codes[1] {
		t.Fatalf("regenerate returned %d codes (first %q), want a fresh set of 10", len(regen.BackupCodes), regen.BackupCodes[0])
	}
	partial = challenge(t, router, "recovery-user")
	if status, _ := verifyWith(t, router, partial, enr.codes[1]); status != http.StatusUnauthorized {
		t.Fatalf("an old unused code survived regeneration: status = %d", status)
	}
	if status, body := verifyWith(t, router, partial, regen.BackupCodes[0]); status != http.StatusOK {
		t.Fatalf("a regenerated code was refused: status = %d, body = %v", status, body)
	}

	// Disabling 2FA removes the codes.
	rr = deleteWithToken(t, router, "/api/v1/users/me/totp", token, map[string]string{"password": recoveryTestPassword})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("disable: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var left int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM totp_recovery_codes`).Scan(&left); err != nil {
		t.Fatalf("count codes: %v", err)
	}
	if left != 0 {
		t.Fatalf("%d recovery-code rows survived disabling 2FA, want 0", left)
	}
}

func TestRecoveryCodes_RegenerateRequiresTOTP(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	token := loginAndGetToken(t, router, database, "no-totp-yet", 4)

	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/recovery-codes", token,
		map[string]string{"password": recoveryTestPassword})
	if rr.Code != http.StatusConflict {
		t.Fatalf("regenerate without 2FA: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["error"] != "CONFLICT" {
		t.Fatalf("error = %v, want CONFLICT", body["error"])
	}
}

// The stored form is a bcrypt hash: a database dump holds no usable code.
func TestRecoveryCodes_StoredHashedOnly(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	token := loginAndGetToken(t, router, database, "hashed-user", 4)
	enr := enrolWithCodes(t, router, token)

	rows, err := database.SQLDb().QueryContext(context.Background(), `SELECT code_hash FROM totp_recovery_codes`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var n int
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			t.Fatalf("scan: %v", err)
		}
		n++
		if !strings.HasPrefix(h, "$2") {
			t.Fatalf("code_hash %q is not a bcrypt hash", h)
		}
		for _, c := range enr.codes {
			canonical, _ := auth.NormalizeRecoveryCode(c)
			if strings.Contains(h, canonical) || strings.Contains(h, c) {
				t.Fatalf("a recovery code appears in its stored row: %q", h)
			}
		}
	}
	if n != 10 {
		t.Fatalf("stored %d code rows, want 10", n)
	}
}
