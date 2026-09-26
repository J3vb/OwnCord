package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// First-run bootstrap has one gate and one ordering rule, and both are the
// kind that only bite once, on a server nobody is watching yet.

func setupFixture(t *testing.T) (*SetupService, *db.DB, context.Context) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner", Position: permissions.OwnerRolePosition})
	return NewSetupService(database), database, context.Background()
}

func TestSetupService_BootstrapMakesAServerUsable(t *testing.T) {
	svc, database, ctx := setupFixture(t)

	needs, err := svc.NeedsSetup(ctx)
	if err != nil || !needs {
		t.Fatalf("NeedsSetup on an empty server = %v, %v; want true", needs, err)
	}

	res, err := svc.Bootstrap(ctx, BootstrapInput{
		Username: "owner", Password: "correct horse battery staple",
		Device: "Mozilla/5.0", Host: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	if res.OwnerID == 0 || res.Token == "" || res.InviteCode == "" {
		t.Fatalf("Bootstrap returned %+v — a healthy first run issues a session and an invite", res)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("healthy first run produced warnings: %v", res.Warnings)
	}

	// The password is stored hashed, never as given.
	var stored string
	if err := database.QueryRowContext(ctx, `SELECT password FROM users WHERE id = ?`, res.OwnerID).Scan(&stored); err != nil {
		t.Fatalf("reading the stored password: %v", err)
	}
	if stored == "" || strings.Contains(stored, "correct horse") {
		t.Errorf("the password is recoverable from the users row")
	}

	// The two default channels exist, so the owner does not land in an empty
	// server with nothing to click.
	var channels int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels`).Scan(&channels); err != nil {
		t.Fatalf("counting channels: %v", err)
	}
	if channels != 2 {
		t.Errorf("first run created %d channels, want 2 (one text, one voice)", channels)
	}

	// The bootstrap invite is bounded, not an unlimited standing way in.
	var maxUses int
	var expires *string
	if err := database.QueryRowContext(ctx,
		`SELECT max_uses, expires_at FROM invites WHERE code = ?`, res.InviteCode).Scan(&maxUses, &expires); err != nil {
		t.Fatalf("reading the bootstrap invite: %v", err)
	}
	if maxUses != bootstrapInviteUses {
		t.Errorf("bootstrap invite max_uses = %d, want %d", maxUses, bootstrapInviteUses)
	}
	if expires == nil || *expires == "" {
		t.Error("the bootstrap invite never expires — setup must not leave a permanent way in")
	}

	if needs, err := svc.NeedsSetup(ctx); err != nil || needs {
		t.Errorf("NeedsSetup after bootstrap = %v, %v; want false", needs, err)
	}
}

// The gate is the atomic insert, not a preceding count: a second call must be
// refused even though nothing re-checked NeedsSetup in between. This endpoint
// is unauthenticated, so this refusal is the only thing between it and anyone
// who can reach the port.
func TestSetupService_BootstrapIsRefusedOnceAnAccountExists(t *testing.T) {
	svc, database, ctx := setupFixture(t)

	first, err := svc.Bootstrap(ctx, BootstrapInput{Username: "owner", Password: "first-password-here"})
	if err != nil {
		t.Fatalf("first Bootstrap: %v", err)
	}

	_, err = svc.Bootstrap(ctx, BootstrapInput{Username: "usurper", Password: "second-password-here"})
	if !errors.Is(err, ErrSetupAlreadyDone) {
		t.Fatalf("second Bootstrap: err = %v, want ErrSetupAlreadyDone", err)
	}

	// The refused call left nothing behind, and the real owner is untouched.
	var users int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		t.Fatalf("counting users: %v", err)
	}
	if users != 1 {
		t.Errorf("%d users exist after a refused second setup, want 1", users)
	}
	var name string
	if err := database.QueryRowContext(ctx, `SELECT username FROM users WHERE id = ?`, first.OwnerID).Scan(&name); err != nil {
		t.Fatalf("re-reading the owner: %v", err)
	}
	if name != "owner" {
		t.Errorf("owner username = %q, want \"owner\"", name)
	}
}

// OC-0253: once the account commits, a downstream failure is a WARNING, never
// an error. Reporting an error would tell the caller to retry, and every retry
// hits the gate above — the account would be orphaned forever, with no session
// and no invite. Forced here by removing the invites table so exactly one
// downstream step fails while the rest succeed.
func TestSetupService_DownstreamFailureWarnsRatherThanOrphansTheAccount(t *testing.T) {
	svc, database, ctx := setupFixture(t)
	if _, err := database.ExecContext(ctx, `DROP TABLE invites`); err != nil {
		t.Fatalf("dropping invites: %v", err)
	}

	res, err := svc.Bootstrap(ctx, BootstrapInput{Username: "owner", Password: "a-good-password-here"})
	if err != nil {
		t.Fatalf("Bootstrap returned an error for a post-commit failure: %v — "+
			"the caller would retry, hit \"setup already completed\", and the account "+
			"would be orphaned with no session and no invite (OC-0253)", err)
	}
	if res.OwnerID == 0 {
		t.Fatal("no owner id returned")
	}
	if res.InviteCode != "" {
		t.Errorf("InviteCode = %q despite the invite failing", res.InviteCode)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "invite") {
		t.Errorf("warnings = %v, want one naming the invite", res.Warnings)
	}
	// The session still worked, so the owner is logged in despite the failure.
	if res.Token == "" {
		t.Error("the session was lost along with the invite — the two steps must be independent")
	}
}

// A long User-Agent is truncated rather than rejected: the device string is
// cosmetic, and refusing a first run over it would be absurd.
func TestSetupService_BootstrapTruncatesTheDeviceString(t *testing.T) {
	svc, database, ctx := setupFixture(t)

	res, err := svc.Bootstrap(ctx, BootstrapInput{
		Username: "owner", Password: "a-good-password-here",
		Device: strings.Repeat("x", 2000),
	})
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	var device string
	if err := database.QueryRowContext(ctx,
		`SELECT device FROM sessions WHERE user_id = ?`, res.OwnerID).Scan(&device); err != nil {
		t.Fatalf("reading the session device: %v", err)
	}
	if len(device) != 512 {
		t.Errorf("stored device length = %d, want 512", len(device))
	}
}

func TestSetupService_ApplyWizardSettings(t *testing.T) {
	svc, database, ctx := setupFixture(t)
	settings := NewSettingsService(database)

	// An empty map is a no-op, not an empty transaction.
	if err := svc.ApplyWizardSettings(ctx, map[string]string{}); err != nil {
		t.Fatalf("ApplyWizardSettings(empty): %v", err)
	}

	if err := svc.ApplyWizardSettings(ctx, map[string]string{
		"server_name":       "Bootstrapped",
		"motd":              "Hello",
		"registration_open": "0",
	}); err != nil {
		t.Fatalf("ApplyWizardSettings: %v", err)
	}
	for key, want := range map[string]string{
		"server_name": "Bootstrapped", "motd": "Hello", "registration_open": "0",
	} {
		got, err := settings.Setting(ctx, key)
		if err != nil || got != want {
			t.Errorf("setting %s = %q, %v; want %q", key, got, err, want)
		}
	}
}

func TestSetupService_FailsLoudBeforeTheAccountExists(t *testing.T) {
	svc, database, ctx := setupFixture(t)
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := svc.NeedsSetup(ctx); !errors.Is(err, ErrInternal) {
		t.Errorf("NeedsSetup on a closed database: err = %v, want ErrInternal", err)
	}
	// Before the commit, a failure IS an error — the account does not exist,
	// so a retry is exactly the right thing for the caller to do.
	_, err := svc.Bootstrap(ctx, BootstrapInput{Username: "owner", Password: "a-good-password-here"})
	if !errors.Is(err, ErrInternal) {
		t.Errorf("Bootstrap on a closed database: err = %v, want ErrInternal", err)
	}
	if errors.Is(err, ErrSetupAlreadyDone) {
		t.Error("an outage was reported as \"setup already completed\" — the server would " +
			"be permanently unclaimable with no account to claim it")
	}
	if err := svc.ApplyWizardSettings(ctx, map[string]string{"motd": "x"}); !errors.Is(err, ErrInternal) {
		t.Errorf("ApplyWizardSettings on a closed database: err = %v, want ErrInternal", err)
	}
}
