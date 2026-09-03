package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
)

// TestAuditCoverage_APIMutations is the B2-6 audit table for the
// api-owned security-sensitive mutations (TOTP enrolment and removal,
// account self-deletion). The plugin lifecycle rows live in
// audit_coverage_plugin_test.go because their fixtures are package-internal.
// The closing subtest runs the detail denylist over the recorded corpus
// (plan docs/plans/b2-protocol-trust-compat-2026-08-28.md § B2-6).
func TestAuditCoverage_APIMutations(t *testing.T) {
	const password = "Password1!"

	// enrolTOTP runs enable+confirm for token and returns the TOTP secret
	// and the confirmation code, both fixture secrets for the denylist.
	enrolTOTP := func(t *testing.T, router http.Handler, token string) (secret, code string) {
		t.Helper()
		rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
			map[string]string{"password": password})
		if rr.Code != http.StatusOK {
			t.Fatalf("enable: status = %d; body = %s", rr.Code, rr.Body.String())
		}
		var enableResp map[string]any
		_ = json.NewDecoder(rr.Body).Decode(&enableResp)
		secret = extractSecretFromURI(t, enableResp["qr_uri"].(string))
		code, _ = auth.GenerateTOTPCode(secret, time.Now().UTC())
		rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
			map[string]string{"password": password, "code": code})
		if rr.Code != http.StatusNoContent {
			t.Fatalf("confirm: status = %d; body = %s", rr.Code, rr.Body.String())
		}
		return secret, code
	}

	rows := []struct {
		name   string
		action string
		run    func(t *testing.T) (*audittest.Recorder, []string)
	}{
		{"totp enable", "totp_enabled", func(t *testing.T) (*audittest.Recorder, []string) {
			database := newAuthTestDB(t)
			router := buildAuthRouter(database, auth.NewRateLimiter())
			token := loginAndGetToken(t, router, database, "totpenable", 4)
			rec := audittest.Install(t, database)
			secret, code := enrolTOTP(t, router, token)
			return rec, []string{password, token, secret, code}
		}},
		{"totp disable", "totp_disabled", func(t *testing.T) (*audittest.Recorder, []string) {
			database := newAuthTestDB(t)
			router := buildAuthRouter(database, auth.NewRateLimiter())
			token := loginAndGetToken(t, router, database, "totpdisable", 4)
			secret, code := enrolTOTP(t, router, token)
			rec := audittest.Install(t, database)
			rr := deleteWithToken(t, router, "/api/v1/users/me/totp", token,
				map[string]string{"password": password})
			if rr.Code != http.StatusNoContent {
				t.Fatalf("disable: status = %d; body = %s", rr.Code, rr.Body.String())
			}
			return rec, []string{password, token, secret, code}
		}},
		{"recovery codes regenerate", "recovery_codes_regenerated", func(t *testing.T) (*audittest.Recorder, []string) {
			database := newAuthTestDB(t)
			router := buildAuthRouter(database, auth.NewRateLimiter())
			token := loginAndGetToken(t, router, database, "totpregen", 4)
			secret, code := enrolTOTP(t, router, token)
			rec := audittest.Install(t, database)
			rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/recovery-codes", token,
				map[string]string{"password": password})
			if rr.Code != http.StatusOK {
				t.Fatalf("regenerate: status = %d; body = %s", rr.Code, rr.Body.String())
			}
			var resp struct {
				BackupCodes []string `json:"backup_codes"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			// The codes are secrets: the audit row must not carry them.
			return rec, append([]string{password, token, secret, code}, resp.BackupCodes...)
		}},
		{"account delete", "account_deleted", func(t *testing.T) (*audittest.Recorder, []string) {
			database := newMigratedAuthTestDB(t)
			router := buildAuthRouter(database, auth.NewRateLimiter())
			hash, _ := auth.HashPassword(password)
			uid, _ := database.CreateUser(context.Background(), "selfdelete", hash, 4)
			token, _ := auth.GenerateToken()
			_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")
			rec := audittest.Install(t, database)
			rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token,
				map[string]string{"password": password})
			if rr.Code != http.StatusNoContent {
				t.Fatalf("delete account: status = %d; body = %s", rr.Code, rr.Body.String())
			}
			return rec, []string{password, hash, token}
		}},
	}

	var corpus []db.AuditEntry
	var secrets []string
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			rec, s := row.run(t)
			rec.Wait(t, row.action)
			corpus = append(corpus, rec.Entries()...)
			secrets = append(secrets, s...)
		})
	}
	t.Run("detail denylist", func(t *testing.T) {
		if len(corpus) == 0 {
			t.Fatal("no audit entries recorded")
		}
		audittest.AssertSafeDetails(t, corpus, secrets...)
	})
}
