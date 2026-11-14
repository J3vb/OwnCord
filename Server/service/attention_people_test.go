package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// peopleService is an AttentionService whose only source is People.
func peopleService(src func(context.Context) AttentionPeople) *AttentionService {
	return NewAttentionService(AttentionThresholds{}, AttentionSources{People: src})
}

func evalAt(s *AttentionService, now time.Time) AttentionReport {
	s.Evaluate(context.Background(), now)
	return s.Report()
}

var peopleIDs = []string{"owner_recovery_kit", "moderators", "moderate_role"}

func TestAttentionPeople_NilSourceIsUnknown(t *testing.T) {
	rep := evalAt(NewAttentionService(AttentionThresholds{}, AttentionSources{}), time.Now())
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusUnknown)
	}
	if len(rep.Warnings) != 0 {
		t.Fatalf("unknown signals raised warnings: %+v", rep.Warnings)
	}
}

func TestAttentionPeople_WarnsAndExplains(t *testing.T) {
	s := peopleService(func(context.Context) AttentionPeople { return AttentionPeople{Moderators: 1} })
	rep := evalAt(s, time.Now())
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusWarning)
		if w := warning(rep, id); w == nil || w.Title == "" || w.Action == "" {
			t.Fatalf("%s warning = %+v, want title and action", id, w)
		}
	}
	if got := signal(t, rep, "moderators").Value; got != "1 person" {
		t.Fatalf("moderators value = %q, want %q", got, "1 person")
	}
	if a := warning(rep, "owner_recovery_kit").Action; !strings.Contains(a, "running setup again") {
		t.Fatalf("kit action = %q, want the consequence named", a)
	}
}

// Edge case 1: a failed read is unknown with a reason, never ok, and neither raises nor
// clears an existing warning.
func TestAttentionPeople_ReadFailureIsUnknownAndKeepsWarnings(t *testing.T) {
	p := AttentionPeople{Moderators: 1}
	s := peopleService(func(context.Context) AttentionPeople { return p })
	now := time.Now()
	wantStatus(t, evalAt(s, now), "moderators", AttentionStatusWarning)

	boom := errors.New("database is locked")
	p = AttentionPeople{KitErr: boom, CoverageErr: boom}
	rep := evalAt(s, now.Add(time.Minute))
	for _, id := range peopleIDs {
		sig := signal(t, rep, id)
		if sig.Status != AttentionStatusUnknown || !strings.Contains(sig.Detail, "database is locked") {
			t.Fatalf("%s = %+v, want unknown with the reason", id, sig)
		}
		w := warning(rep, id)
		if w == nil || w.RecoveredAt != nil {
			t.Fatalf("%s warning after a failed read = %+v, want it still active", id, w)
		}
	}

	// An unknown never raises one either.
	fresh := peopleService(func(context.Context) AttentionPeople { return p })
	if rep := evalAt(fresh, now); len(rep.Warnings) != 0 {
		t.Fatalf("failed reads raised warnings: %+v", rep.Warnings)
	}
}

// Edge case 2: the owner fixes it between samples and the next Evaluate recovers it.
func TestAttentionPeople_FixBetweenSamplesRecovers(t *testing.T) {
	p := AttentionPeople{Moderators: 1}
	s := peopleService(func(context.Context) AttentionPeople { return p })
	now := time.Now()
	evalAt(s, now)

	p = AttentionPeople{OwnerHasKit: true, Moderators: 2, ModerateRoles: 1}
	rep := evalAt(s, now.Add(time.Minute))
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusOK)
		if w := warning(rep, id); w == nil || w.RecoveredAt == nil {
			t.Fatalf("%s warning = %+v, want recovered", id, w)
		}
	}
}

func TestAttentionPeople_SpentKitWarns(t *testing.T) {
	s := peopleService(func(context.Context) AttentionPeople {
		return AttentionPeople{OwnerKitSpent: true, Moderators: 2, ModerateRoles: 1}
	})
	rep := evalAt(s, time.Now())
	wantStatus(t, rep, "owner_recovery_kit", AttentionStatusWarning)
	if v := signal(t, rep, "owner_recovery_kit").Value; v != "kit already used" {
		t.Fatalf("value = %q", v)
	}
}

// The source passed to Evaluate gets the sample context.
func TestAttentionPeople_SourceGetsSampleContext(t *testing.T) {
	type key struct{}
	var got any
	s := peopleService(func(ctx context.Context) AttentionPeople {
		got = ctx.Value(key{})
		return AttentionPeople{}
	})
	s.Evaluate(context.WithValue(context.Background(), key{}, "sample"), time.Now())
	if got != "sample" {
		t.Fatalf("source context value = %v, want the sample context", got)
	}
}

func peopleFromDB(ctx context.Context, t *testing.T, database *db.DB) AttentionPeople {
	t.Helper()
	return PeopleSource(database)(ctx)
}

func seedPerson(t *testing.T, database *db.DB, name string, roleID int64) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), name, "hash", int(roleID))
	mustDo(t, "CreateUser "+name, err)
	return id
}

func setStatus(t *testing.T, database *db.DB, id int64, status string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(), `UPDATE users SET registration_status = ? WHERE id = ?`, status, id)
	mustDo(t, "set registration_status", err)
}

// A fresh server with only the owner: one person, and the default Moderator role carries the bit.
func TestAttentionPeople_FreshServerOnlyOwner(t *testing.T) {
	database := newTestDB(t)
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	p := peopleFromDB(context.Background(), t, database)
	if p.KitErr != nil || p.CoverageErr != nil {
		t.Fatalf("errors: %v / %v", p.KitErr, p.CoverageErr)
	}
	if p.Moderators != 1 || p.OwnerHasKit {
		t.Fatalf("people = %+v, want 1 moderator and no kit", p)
	}
	s := peopleService(func(context.Context) AttentionPeople { return p })
	rep := evalAt(s, time.Now())
	wantStatus(t, rep, "moderators", AttentionStatusWarning)
	wantStatus(t, rep, "owner_recovery_kit", AttentionStatusWarning)
}

func TestAttentionPeople_OwnerAndModeratorAreCovered(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	owner := seedPerson(t, database, "owner", permissions.OwnerRoleID)
	seedPerson(t, database, "mod", permissions.ModeratorRoleID)
	seedPerson(t, database, "plain", permissions.MemberRoleID)
	mustDo(t, "UpsertRecoveryKit", database.UpsertRecoveryKit(ctx, owner, "verifier"))

	p := peopleFromDB(context.Background(), t, database)
	if p.Moderators != 2 || p.ModerateRoles < 1 || !p.OwnerHasKit || p.KitErr != nil || p.CoverageErr != nil {
		t.Fatalf("people = %+v, want 2 moderators, a moderate role and a kit", p)
	}
	rep := evalAt(peopleService(func(context.Context) AttentionPeople { return p }), time.Now())
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusOK)
	}
}

// Banned, pending and system accounts do not count, and an Administrator counts as a
// person but not as a role that carries the bit.
func TestAttentionPeople_OnlyActiveAccountsCount(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	banned := seedPerson(t, database, "banned-mod", permissions.ModeratorRoleID)
	pending := seedPerson(t, database, "pending-mod", permissions.ModeratorRoleID)
	system := seedPerson(t, database, "system-admin", permissions.AdminRoleID)
	_, err := database.ExecContext(ctx, `UPDATE users SET banned = 1 WHERE id = ?`, banned)
	mustDo(t, "ban", err)
	setStatus(t, database, pending, "pending")
	setStatus(t, database, system, "system")

	if p := peopleFromDB(context.Background(), t, database); p.Moderators != 1 {
		t.Fatalf("moderators = %d, want 1 (banned, pending and system excluded)", p.Moderators)
	}

	seedPerson(t, database, "admin", permissions.AdminRoleID)
	if p := peopleFromDB(context.Background(), t, database); p.Moderators != 2 {
		t.Fatalf("moderators with an Administrator = %d, want 2", p.Moderators)
	}
}

// A customised Moderator role that lost the bit leaves no role but Owner carrying it, and a
// seeded Admin role that lost it no longer counts as a moderator; giving it back clears the finding.
func TestAttentionPeople_ModerateRoleIgnoresAdministrator(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	seedPerson(t, database, "admin", permissions.AdminRoleID)
	mustDo(t, "strip bit", func() error {
		_, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions & ~? WHERE id <> ?`,
			permissions.ModerateMembers, permissions.OwnerRoleID)
		return err
	}())

	p := peopleFromDB(context.Background(), t, database)
	if p.ModerateRoles != 0 || p.Moderators != 1 {
		t.Fatalf("people = %+v, want no moderate role and 1 moderator (the seeded Admin role lost the bit)", p)
	}
	s := peopleService(func(ctx context.Context) AttentionPeople { return peopleFromDB(ctx, t, database) })
	now := time.Now()
	rep := evalAt(s, now)
	wantStatus(t, rep, "moderate_role", AttentionStatusWarning)
	wantStatus(t, rep, "moderators", AttentionStatusWarning)

	mustDo(t, "grant bit", func() error {
		_, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions | ? WHERE id = ?`,
			permissions.ModerateMembers, permissions.ModeratorRoleID)
		return err
	}())
	rep = evalAt(s, now.Add(time.Minute))
	wantStatus(t, rep, "moderate_role", AttentionStatusOK)
	if w := warning(rep, "moderate_role"); w == nil || w.RecoveredAt == nil {
		t.Fatalf("moderate_role warning = %+v, want recovered", w)
	}
}

// A custom role holding only Administrator lets its holder work reports, as CanModerate does,
// but is not a role that carries Moderate Members.
func TestAttentionPeople_AdministratorOnlyRoleCounts(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 10, Name: "Root", Permissions: permissions.Administrator, Position: 50})
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	seedPerson(t, database, "root", 10)
	p := peopleFromDB(context.Background(), t, database)
	if p.Moderators != 2 {
		t.Fatalf("moderators = %d, want 2 (owner and the Administrator-only role)", p.Moderators)
	}
}

// A temporary ban that has lapsed counts again; one still running does not.
func TestAttentionPeople_ExpiredTempBanCountsAgain(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	lapsed := seedPerson(t, database, "lapsed", permissions.ModeratorRoleID)
	running := seedPerson(t, database, "running", permissions.ModeratorRoleID)
	_, err := database.ExecContext(ctx, `UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?`,
		time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05Z"), lapsed)
	mustDo(t, "lapsed ban", err)
	_, err = database.ExecContext(ctx, `UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?`,
		time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05Z"), running)
	mustDo(t, "running ban", err)
	if p := peopleFromDB(context.Background(), t, database); p.Moderators != 2 {
		t.Fatalf("moderators = %d, want 2 (owner and the lapsed ban)", p.Moderators)
	}
}

// An account whose erasure is queued no longer counts.
func TestAttentionPeople_QueuedErasureNotCounted(t *testing.T) {
	database := newTestDB(t)
	seedPerson(t, database, "owner", permissions.OwnerRoleID)
	erasing := seedPerson(t, database, "erasing", permissions.ModeratorRoleID)
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO erasure_jobs (user_id, state, files) VALUES (?, 'queued', '[]')`, erasing)
	mustDo(t, "queue erasure", err)
	if p := peopleFromDB(context.Background(), t, database); p.Moderators != 1 {
		t.Fatalf("moderators = %d, want 1", p.Moderators)
	}
}

// The highest-ranked live account is only the owner when it holds the owner role; otherwise
// the kit signal is unknown with "no owner account found", never a verdict about someone else.
func TestAttentionPeople_NonOwnerTopAccountIsUnknown(t *testing.T) {
	database := newTestDB(t)
	seedPerson(t, database, "admin", permissions.AdminRoleID)
	p := peopleFromDB(context.Background(), t, database)
	if p.KitErr == nil || !strings.Contains(p.KitErr.Error(), "no owner account found") {
		t.Fatalf("KitErr = %v, want no owner account found", p.KitErr)
	}
	rep := evalAt(peopleService(func(context.Context) AttentionPeople { return p }), time.Now())
	wantStatus(t, rep, "owner_recovery_kit", AttentionStatusUnknown)
}

// A database that cannot be read yields errors in both halves, not zero counts.
func TestAttentionPeople_ClosedDatabaseIsUnknown(t *testing.T) {
	database := newTestDB(t)
	mustDo(t, "Close", database.Close())
	p := peopleFromDB(context.Background(), t, database)
	if p.KitErr == nil || p.CoverageErr == nil {
		t.Fatalf("people = %+v, want both errors", p)
	}
	rep := evalAt(peopleService(func(context.Context) AttentionPeople { return p }), time.Now())
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusUnknown)
	}
}
