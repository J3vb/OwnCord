package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
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
	// require_2fa's preconditions hold on a closed, user-less server.
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "TRUE",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, err := database.GetSetting(context.Background(), "require_2fa")
	if err != nil || got != "1" {
		t.Fatalf("require_2fa = %q, %v; want \"1\"", got, err)
	}
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa": "false",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, _ = database.GetSetting(context.Background(), "require_2fa")
	if got != "0" {
		t.Fatalf("require_2fa = %q, want \"0\"", got)
	}
}

func TestSettings_PatchNormalizesRegistrationMode(t *testing.T) {
	svc, database := newSettingsService(t)
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_mode": "  APPROVAL ",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, err := database.GetSetting(context.Background(), "registration_mode")
	if err != nil || got != "approval" {
		t.Fatalf("registration_mode = %q, %v; want \"approval\"", got, err)
	}
}

func TestSettings_PatchRejectsInvalidBoolean(t *testing.T) {
	svc, _ := newSettingsService(t)
	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa": "maybe",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := `require_2fa: invalid boolean value "maybe"`; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
}

func TestSettings_PatchRejectsUnknownRegistrationMode(t *testing.T) {
	svc, database := newSettingsService(t)
	before, _ := database.GetSetting(context.Background(), "registration_mode")
	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_mode": "sometimes",
	})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if want := "registration_mode: must be one of closed, invite, approval, open"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
	if after, _ := database.GetSetting(context.Background(), "registration_mode"); after != before {
		t.Fatalf("registration_mode changed to %q despite the rejected value", after)
	}
}

func TestSettings_Require2FARejectedUnlessRegistrationClosed(t *testing.T) {
	svc, _ := newSettingsService(t)
	for _, mode := range []string{"invite", "approval", "open"} {
		_, err := svc.Patch(context.Background(), 1, map[string]string{
			"require_2fa":       "1",
			"registration_mode": mode,
		})
		if !errors.Is(err, ErrBadRequest) {
			t.Fatalf("mode %s: err = %v, want ErrBadRequest", mode, err)
		}
		if want := "require_2fa cannot be enabled unless registration is closed"; !strings.Contains(err.Error(), want) {
			t.Fatalf("mode %s: err = %q, want it to contain %q", mode, err, want)
		}
	}
}

func TestSettings_RegistrationCannotReopenWhileRequire2FAOn(t *testing.T) {
	svc, database := newSettingsService(t)
	if _, err := svc.Patch(context.Background(), 1, map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "1",
	}); err != nil {
		t.Fatalf("enable require_2fa: %v", err)
	}
	_, err := svc.Patch(context.Background(), 1, map[string]string{"registration_mode": "invite"})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	if got, _ := database.GetSetting(context.Background(), "registration_mode"); got != "closed" {
		t.Fatalf("registration_mode = %q, want it still closed", got)
	}
}

func TestSettings_Require2FARejectedUntilAllEnrolled(t *testing.T) {
	svc, database := newSettingsService(t)
	seedUser(t, database, &db.User{ID: 1, Username: "un-enrolled"})

	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa":       "1",
		"registration_mode": "closed",
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
		"registration_mode": "closed",
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

// Patches run one at a time, so the registration_mode_change rows chain:
// each row's new mode is the next row's old mode, from the migrated default
// to the value that finally stuck — whatever order the racers landed in.
func TestSettings_RegistrationModeTransitionsChainUnderConcurrency(t *testing.T) {
	svc, database := newSettingsService(t)
	rec := audittest.Install(t, database)
	ctx := context.Background()
	modes := []string{"closed", "approval", "open", "invite", "closed", "approval", "open", "closed"}
	var wg sync.WaitGroup
	for _, m := range modes {
		wg.Go(func() {
			if _, err := svc.Patch(ctx, 1, map[string]string{"registration_mode": m}); err != nil {
				t.Errorf("Patch(%s): %v", m, err)
			}
		})
	}
	wg.Wait()
	final, err := database.GetSetting(ctx, "registration_mode")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}

	// The audit writer may flush asynchronously: wait until the chain
	// reaches the stored value.
	var rows []db.AuditEntry
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows = rows[:0]
		for _, e := range rec.Entries() {
			if e.Action == "registration_mode_change" {
				rows = append(rows, e)
			}
		}
		if n := len(rows); n > 0 && strings.HasSuffix(rows[n-1].Detail, " -> "+final) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("audit rows never reached the stored mode %q: %d row(s)", final, len(rows))
		}
		time.Sleep(10 * time.Millisecond)
	}
	prev := "invite" // the migrated default
	for i, row := range rows {
		from, to, ok := strings.Cut(strings.TrimPrefix(row.Detail, "registration_mode "), " -> ")
		if !ok {
			t.Fatalf("row %d detail = %q, want 'registration_mode X -> Y'", i, row.Detail)
		}
		if from != prev {
			t.Fatalf("row %d reads %s -> %s, but the previous row ended at %s: the transitions do not chain", i, from, to, prev)
		}
		if from == to {
			t.Fatalf("row %d records a no-op transition %s -> %s", i, from, to)
		}
		prev = to
	}
	if prev != final {
		t.Fatalf("the chain ends at %s, the setting reads %s", prev, final)
	}
}

func TestVoiceOwnerMovable_OwnerOnlyKeyAndDefault(t *testing.T) {
	if !IsOwnerOnlySettingKey(VoiceOwnerMovableKey) {
		t.Error("voice_owner_movable must be an owner-only setting key")
	}
	for stored, want := range map[string]bool{"": true, "true": true, "false": false, "0": false, "1": true, "junk": false} {
		if got := VoiceOwnerMovable(stored); got != want {
			t.Errorf("VoiceOwnerMovable(%q) = %v, want %v", stored, got, want)
		}
	}
}

// WP 8.3e-2: the game activity switch is the admin's (MANAGE_SERVER), not the
// owner's, and a missing row means on.
func TestGameActivityEnabled_BlankTrueGarbageFalse(t *testing.T) {
	if IsOwnerOnlySettingKey(GameActivityEnabledKey) {
		t.Error("game_activity_enabled must not be an owner-only setting key")
	}
	for stored, want := range map[string]bool{"": true, "  ": true, "true": true, "false": false, "0": false, "1": true, "junk": false} {
		if got := GameActivityEnabled(stored); got != want {
			t.Errorf("GameActivityEnabled(%q) = %v, want %v", stored, got, want)
		}
	}
}

func TestSettingsPatch_GameActivityEnabled_Normalizes(t *testing.T) {
	svc, database := newSettingsService(t)
	ctx := context.Background()
	for in, want := range map[string]string{"FALSE": "false", "0": "false", "true": "true", "1": "true"} {
		if _, err := svc.Patch(ctx, 1, map[string]string{GameActivityEnabledKey: in}); err != nil {
			t.Fatalf("Patch %q: %v", in, err)
		}
		if got, err := database.GetSetting(ctx, GameActivityEnabledKey); err != nil || got != want {
			t.Errorf("stored after %q = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := svc.Patch(ctx, 1, map[string]string{GameActivityEnabledKey: "maybe"}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("Patch \"maybe\" err = %v, want ErrBadRequest", err)
	}
}

func TestGameActivityEnabledFromRead(t *testing.T) {
	boom := errors.New("read failed")
	cases := []struct {
		name        string
		stored      string
		err         error
		wantEnabled bool
		wantOK      bool
	}{
		{"stored false", "false", nil, false, true},
		{"stored true", "true", nil, true, true},
		{"blank", "", nil, true, true},
		{"missing row", "", db.ErrNotFound, true, true},
		{"wrapped missing row", "", fmt.Errorf("GetSetting: %w", db.ErrNotFound), true, true},
		{"garbage", "junk", nil, false, true},
		{"read failed", "", boom, false, false},
	}
	for _, tc := range cases {
		enabled, ok, rerr := GameActivityEnabledFromRead(tc.stored, tc.err)
		if enabled != tc.wantEnabled || ok != tc.wantOK || (rerr != nil) != !tc.wantOK || (!tc.wantOK && !errors.Is(rerr, tc.err)) {
			t.Errorf("%s: got (%v, %v), want (%v, %v)", tc.name, enabled, ok, tc.wantEnabled, tc.wantOK)
		}
	}
}
