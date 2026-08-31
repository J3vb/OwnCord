package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The settings family's service-level characterization (B3-8). The admin
// handler surface is pinned by admin/api_test.go's TestAdminAPI_PatchSettings_*
// rows; these tests pin the same policy at the service seam the handlers now
// delegate to, plus the contracts only the service exposes (Setting's
// ErrNotFound wrap, the audit rows, multi-key atomic apply).

func newSettingsService(t *testing.T) (*SettingsService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	return NewSettingsService(database), database
}

func TestSettings_ListContainsMigratedDefaults(t *testing.T) {
	svc, _ := newSettingsService(t)
	all, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, ok := all["server_name"]; !ok {
		t.Fatalf("List missing server_name; got keys %v", len(all))
	}
}

func TestSettings_PatchRejectsUnknownKeyWritingNothing(t *testing.T) {
	svc, database := newSettingsService(t)
	before, _ := database.GetSetting(context.Background(), "server_name")

	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"server_name": "changed",
		"nope":        "x",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := `unknown setting key: "nope"`; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
	after, _ := database.GetSetting(context.Background(), "server_name")
	if after != before {
		t.Fatalf("server_name changed to %q despite the rejected key", after)
	}
}

func TestSettings_PatchNormalizesBooleans(t *testing.T) {
	svc, database := newSettingsService(t)
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_open": "TRUE",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, err := database.GetSetting(context.Background(), "registration_open")
	if err != nil || got != "1" {
		t.Fatalf("registration_open = %q, %v; want \"1\"", got, err)
	}
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_open": "false",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, _ = database.GetSetting(context.Background(), "registration_open")
	if got != "0" {
		t.Fatalf("registration_open = %q, want \"0\"", got)
	}
}

func TestSettings_PatchRejectsInvalidBoolean(t *testing.T) {
	svc, _ := newSettingsService(t)
	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_open": "maybe",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := `registration_open: invalid boolean value "maybe"`; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
}

func TestSettings_Require2FARejectedWhileRegistrationOpen(t *testing.T) {
	svc, _ := newSettingsService(t)
	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa":       "1",
		"registration_open": "1",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := "require_2fa cannot be enabled while registration is open"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
}

func TestSettings_Require2FARejectedUntilAllEnrolled(t *testing.T) {
	svc, database := newSettingsService(t)
	seedUser(t, database, &db.User{ID: 1, Username: "un-enrolled"})

	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa":       "1",
		"registration_open": "0",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := "require_2fa cannot be enabled until all users have 2FA enabled"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
}

func TestSettings_Require2FAAllowedWithNoUnenrolledUsers(t *testing.T) {
	svc, database := newSettingsService(t)
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa":       "1",
		"registration_open": "0",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, _ := database.GetSetting(context.Background(), "require_2fa")
	if got != "1" {
		t.Fatalf("require_2fa = %q, want \"1\"", got)
	}
}

func TestSettings_UnrelatedKeyNotBlockedByRequire2FAGate(t *testing.T) {
	svc, database := newSettingsService(t)
	// require_2fa already on, and a user without TOTP exists: an unrelated
	// PATCH must not inherit the gate (the wedged-settings-page regression).
	if err := database.SetSetting(context.Background(), "require_2fa", "1"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	seedUser(t, database, &db.User{ID: 1, Username: "un-enrolled"})

	if _, err := svc.Patch(context.Background(), 1, map[string]string{"motd": "hello"}); err != nil {
		t.Fatalf("unrelated Patch blocked: %v", err)
	}
	got, _ := database.GetSetting(context.Background(), "motd")
	if got != "hello" {
		t.Fatalf("motd = %q, want \"hello\"", got)
	}
}

func TestSettings_PatchAppliesAllKeysAndAudits(t *testing.T) {
	svc, database := newSettingsService(t)
	after, err := svc.Patch(context.Background(), 7, map[string]string{
		"server_name": "Renamed",
		"motd":        "Welcome",
	})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if after["server_name"] != "Renamed" || after["motd"] != "Welcome" {
		t.Fatalf("returned map = %q/%q, want the applied values", after["server_name"], after["motd"])
	}

	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	changes := 0
	for _, e := range entries {
		if e.Action == "setting_change" && e.ActorID == 7 {
			changes++
		}
	}
	if changes != 2 {
		t.Fatalf("setting_change audit rows = %d, want 2", changes)
	}
}

func TestSettings_SettingWrapsErrNotFound(t *testing.T) {
	svc, _ := newSettingsService(t)
	if _, err := svc.Setting(context.Background(), "no_such_key"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want db.ErrNotFound", err)
	}
	name, err := svc.Setting(context.Background(), "server_name")
	if err != nil || name == "" {
		t.Fatalf("Setting(server_name) = %q, %v", name, err)
	}
}
