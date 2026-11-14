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

func peopleFromDB(t *testing.T, database *db.DB) AttentionPeople {
	t.Helper()
	return PeopleSource(database)(context.Background())
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
	p := peopleFromDB(t, database)
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

	p := peopleFromDB(t, database)
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

	if p := peopleFromDB(t, database); p.Moderators != 1 {
		t.Fatalf("moderators = %d, want 1 (banned, pending and system excluded)", p.Moderators)
	}

	seedPerson(t, database, "admin", permissions.AdminRoleID)
	if p := peopleFromDB(t, database); p.Moderators != 2 {
		t.Fatalf("moderators with an Administrator = %d, want 2", p.Moderators)
	}
}

// A customised Moderator role that lost the bit leaves no role but Owner carrying it,
// even with Administrators present; giving it back clears the finding.
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

	p := peopleFromDB(t, database)
	if p.ModerateRoles != 0 || p.Moderators != 2 {
		t.Fatalf("people = %+v, want no moderate role and 2 moderators", p)
	}
	s := peopleService(func(context.Context) AttentionPeople { return peopleFromDB(t, database) })
	now := time.Now()
	rep := evalAt(s, now)
	wantStatus(t, rep, "moderate_role", AttentionStatusWarning)
	wantStatus(t, rep, "moderators", AttentionStatusOK)

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

// A database that cannot be read yields errors in both halves, not zero counts.
func TestAttentionPeople_ClosedDatabaseIsUnknown(t *testing.T) {
	database := newTestDB(t)
	mustDo(t, "Close", database.Close())
	p := peopleFromDB(t, database)
	if p.KitErr == nil || p.CoverageErr == nil {
		t.Fatalf("people = %+v, want both errors", p)
	}
	rep := evalAt(peopleService(func(context.Context) AttentionPeople { return p }), time.Now())
	for _, id := range peopleIDs {
		wantStatus(t, rep, id, AttentionStatusUnknown)
	}
}
