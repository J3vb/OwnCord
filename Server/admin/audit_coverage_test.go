package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestAuditCoverage_AdminMutations is the B2-6 audit table for the
// admin-owned security-sensitive mutations: channel permission edits (role
// and user layer), API-token create/revoke, settings changes and the setup
// wizard's config write. The closing subtest runs the detail denylist over
// the recorded corpus (plan docs/plans/b2-protocol-trust-compat-2026-08-28.md
// § B2-6).
func TestAuditCoverage_AdminMutations(t *testing.T) {

	// fixture returns a handler, an owner token and a channel id, with the
	// recorder installed after seeding.
	fixture := func(t *testing.T) (http.Handler, *db.DB, string, int64) {
		t.Helper()
		database := openAdminTestDB(t)
		handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{},
			newTestServices(database))
		token := createAdminUser(t, database)
		chID, err := database.CreateChannel(context.Background(), "secret", "text", "", "", 0)
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		return handler, database, token, chID
	}
	rows := []struct {
		name   string
		action string
		run    func(t *testing.T) (*audittest.Recorder, []string)
	}{
		{"channel role perms set", "channel_perms_update", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, chID := fixture(t)
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/permissions/3", token,
				map[string]any{"allow": 0, "deny": permissions.ReadMessages})
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, nil
		}},
		{"channel role perms clear", "channel_perms_clear", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, chID := fixture(t)
			if w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/permissions/3", token,
				map[string]any{"allow": 0, "deny": permissions.ReadMessages}); w.Code != http.StatusOK {
				t.Fatalf("seed override: status = %d; body = %s", w.Code, w.Body.String())
			}
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID)+"/permissions/3", token, nil)
			if w.Code != http.StatusNoContent && w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, nil
		}},
		{"channel user perms set", "channel_user_perms_update", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, chID := fixture(t)
			target := seedOverrideTarget(t, database, "override-target")
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token,
				map[string]any{"allow": permissions.ReadMessages, "deny": permissions.SendMessages})
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, nil
		}},
		{"channel user perms clear", "channel_user_perms_clear", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, chID := fixture(t)
			target := seedOverrideTarget(t, database, "override-target")
			if w := doRequest(t, handler, http.MethodPut, "/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token,
				map[string]any{"allow": permissions.ReadMessages, "deny": permissions.SendMessages}); w.Code != http.StatusOK {
				t.Fatalf("seed override: status = %d; body = %s", w.Code, w.Body.String())
			}
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID)+"/user-permissions/"+itoa(target), token, nil)
			if w.Code != http.StatusNoContent && w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, nil
		}},
		{"api token create", "api_token_create", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, _ := fixture(t)
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodPost, "/tokens", token,
				map[string]any{"label": "ci bot", "username": "adminuser"})
			if w.Code != http.StatusCreated {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			var resp struct {
				Token string `json:"token"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			return rec, []string{resp.Token, token}
		}},
		{"api token revoke", "api_token_revoke", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, _ := fixture(t)
			w := doRequest(t, handler, http.MethodPost, "/tokens", token,
				map[string]any{"label": "ci bot", "username": "adminuser"})
			if w.Code != http.StatusCreated {
				t.Fatalf("seed token: status = %d; body = %s", w.Code, w.Body.String())
			}
			var resp struct {
				ID    int64  `json:"id"`
				Token string `json:"token"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			rec := audittest.Install(t, database)
			if w := doRequest(t, handler, http.MethodDelete, "/tokens/"+itoa(resp.ID), token, nil); w.Code != http.StatusNoContent {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, []string{resp.Token, token}
		}},
		{"setting change", "setting_change", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, _ := fixture(t)
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodPatch, "/settings", token,
				map[string]string{"motd": "welcome 4d0d1405"})
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, []string{"welcome 4d0d1405", token}
		}},
		{"registration mode change", "registration_mode_change", func(t *testing.T) (*audittest.Recorder, []string) {
			handler, database, token, _ := fixture(t)
			rec := audittest.Install(t, database)
			w := doRequest(t, handler, http.MethodPatch, "/settings", token,
				map[string]string{"registration_mode": "closed"})
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			return rec, []string{token}
		}},
		{"config write (setup wizard)", "config_write", func(t *testing.T) (*audittest.Recorder, []string) {
			database := openAdminTestDB(t)
			cfgPath := filepath.Join(t.TempDir(), "config.yaml")
			handler := wizardHandler(t, database, cfgPath, make(chan string, 1))
			rec := audittest.Install(t, database)
			const password = "SecurePass123!"
			w := doRequest(t, handler, http.MethodPost, "/setup", "", map[string]any{
				"username": "owner",
				"password": password,
				"wizard":   map[string]any{"server_name": "Audit Server"},
			})
			if w.Code != http.StatusCreated {
				t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
			}
			var resp struct {
				Token string `json:"token"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			return rec, []string{password, resp.Token}
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
