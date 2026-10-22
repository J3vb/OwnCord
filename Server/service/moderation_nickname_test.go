package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// nicknameFixture is WP 6.4a's hierarchy. Roles: owner (pos 100,
// Administrator), admin (90, Administrator only, no MANAGE_NICKNAMES bit),
// mod (80, MANAGE_NICKNAMES), senior (70, no bit), nick (20, MANAGE_NICKNAMES
// only), member (40, none). Users: 1 owner, 2 mod, 3 member, 4 member, 5
// peer mod, 6 admin, 7 holds senior AND nick.
type nicknameFixture struct {
	mod      *ModerationService
	users    *UserService
	database *db.DB
}

const (
	nickOwner  = int64(1)
	nickMod    = int64(2)
	nickMember = int64(3)
	nickOther  = int64(4)
	nickPeer   = int64(5)
	nickAdmin  = int64(6)
	nickMulti  = int64(7)
)

//nolint:contextcheck // seed helpers use context.Background, the package-wide fixture pattern
func newNicknameFixture(t *testing.T) *nicknameFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedRole(t, database, &db.Role{ID: 2, Name: "mod", Permissions: permissions.ManageNicknames | permissions.ReadMessages, Position: 80})
	seedRole(t, database, &db.Role{ID: 3, Name: "member", Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 40})
	seedRole(t, database, &db.Role{ID: 5, Name: "admin", Permissions: permissions.Administrator, Position: 90})
	seedRole(t, database, &db.Role{ID: 6, Name: "senior", Permissions: permissions.ReadMessages, Position: 70})
	seedRole(t, database, &db.Role{ID: 7, Name: "nick", Permissions: permissions.ManageNicknames, Position: 20})
	for userID, roleID := range map[int64]int64{
		nickOwner: 1, nickMod: 2, nickMember: 3, nickOther: 3, nickPeer: 2, nickAdmin: 5, nickMulti: 6,
	} {
		seedUser(t, database, &db.User{ID: userID, Username: fmt.Sprintf("u%d", userID), Status: "offline"})
		seedUserRole(t, database, userID, roleID)
	}
	if err := database.AddUserRole(context.Background(), nickMulti, 7); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	perms := NewPermissionService(database, permissions.NewChecker(database))
	mod := NewModerationService(database, perms)
	users := NewUserService(database)
	mod.users = users
	return &nicknameFixture{mod: mod, users: users, database: database}
}

func (f *nicknameFixture) nickname(ctx context.Context, t *testing.T, id int64) *string {
	t.Helper()
	u, err := f.database.GetUserByID(ctx, id)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID(%d): %v, %v", id, u, err)
	}
	return u.DisplayName
}

func (f *nicknameFixture) setRaw(ctx context.Context, t *testing.T, id int64, name string) {
	t.Helper()
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET display_name = ? WHERE id = ?`, name, id); err != nil {
		t.Fatalf("set display_name: %v", err)
	}
}

func derefOr(p *string, none string) string {
	if p == nil {
		return none
	}
	return *p
}

func TestSetNickname_Authorization(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	unknown := int64(999)

	tests := []struct {
		name    string
		actor   int64
		target  int64
		wantErr error // nil means success
	}{
		{"no bit, unknown id is 403 not 404", nickMember, unknown, ErrForbidden},
		{"no bit, real lower target", nickMember, nickOther, ErrForbidden},
		{"bit holder, unknown id is 404", nickMod, unknown, ErrNotFound},
		{"equal rank", nickMod, nickPeer, ErrForbidden},
		{"lower target", nickMod, nickMember, nil},
		{"Administrator without the bit", nickAdmin, nickMember, nil},
		{"Administrator does not bypass the hierarchy", nickAdmin, nickOwner, ErrForbidden},
		{"bit holder on the Owner", nickMod, nickOwner, ErrForbidden},
		{"target above the actor", nickMod, nickAdmin, ErrForbidden},
		{"self", nickMod, nickMod, ErrBadRequest},
		{"non-positive actor", 0, nickMember, ErrForbidden},
		{"non-positive target", nickMod, 0, ErrBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f.setRaw(ctx, t, nickMember, "before")
			got, err := f.mod.SetNickname(ctx, tc.actor, tc.target, new("After"))
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("SetNickname: %v", err)
				}
				if got == nil || derefOr(got.DisplayName, "") != "After" {
					t.Fatalf("returned user = %+v, want nickname After", got)
				}
				return
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if tc.target == nickMember && derefOr(f.nickname(ctx, t, nickMember), "") != "before" {
				t.Fatalf("a refused change wrote the row")
			}
		})
	}
}

func TestSetNickname_PendingTargetIsNotFound(t *testing.T) {
	f := newNicknameFixture(t)
	if _, err := f.database.ExecContext(context.Background(), `UPDATE users SET registration_status = 'pending' WHERE id = ?`, nickMember); err != nil {
		t.Fatalf("make pending: %v", err)
	}
	if _, err := f.mod.SetNickname(context.Background(), nickMod, nickMember, new("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending target: want ErrNotFound, got %v", err)
	}
	// And a caller without the bit still sees Forbidden, not NotFound.
	if _, err := f.mod.SetNickname(context.Background(), nickOther, nickMember, new("x")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("no bit on a pending target: want ErrForbidden, got %v", err)
	}
}

func TestSetNickname_ValidationMatchesSelfEdit(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	refused := map[string]string{
		"control character":         "a\x00b",
		"line break":                "a\nb",
		"bidi override":             "a\u202eb",
		"entity-encoded bidi":       "a&#8238;b",
		"three stacked marks":       "e\u0301\u0302\u0303",
		"33 runes":                  strings.Repeat("a", 33),
		"far over the raw byte cap": strings.Repeat("a", 500),
		"invisible filler":          "a\u3164b",
	}
	f.setRaw(ctx, t, nickMember, "keep")
	for name, v := range refused {
		// The member's own edit refuses the same value: one validator.
		_, selfErr := f.users.UpdateProfile(ctx, nickOther, ProfilePatch{DisplayName: new(v)})
		if !errors.Is(selfErr, ErrBadRequest) {
			t.Fatalf("%s: self edit err = %v, want ErrBadRequest (the premise of this test)", name, selfErr)
		}
		_, err := f.mod.SetNickname(ctx, nickMod, nickMember, new(v))
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
		if selfErr != nil && err != nil && selfErr.Error() != err.Error() {
			t.Errorf("%s: messages differ: self %q, moderator %q", name, selfErr, err)
		}
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "keep" {
		t.Fatalf("a refused name changed the row to %q", got)
	}

	// 32 runes pass, spaces collapse.
	max := strings.Repeat("é", 32)
	if u, err := f.mod.SetNickname(ctx, nickMod, nickMember, &max); err != nil || derefOr(u.DisplayName, "") != max {
		t.Fatalf("32 runes: %v, %+v", err, u)
	}
	u, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("  Big    Bird  "))
	if err != nil || derefOr(u.DisplayName, "") != "Big Bird" {
		t.Fatalf("collapse: %v, %+v", err, u)
	}

	// "" and nil clear.
	for name, v := range map[string]*string{"empty string": new(""), "null": nil} {
		f.setRaw(ctx, t, nickMember, "named")
		u, err := f.mod.SetNickname(ctx, nickMod, nickMember, v)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if u.DisplayName != nil {
			t.Errorf("%s: returned nickname %q, want cleared", name, *u.DisplayName)
		}
		if got := f.nickname(ctx, t, nickMember); got != nil {
			t.Errorf("%s: stored nickname %q, want NULL", name, *got)
		}
	}
}

// warm fills the permission cache so the service check below sees the state
// from before the change a test then makes straight in the database, the
// window between the service's cached check and the write.
func (f *nicknameFixture) warm(t *testing.T, ids ...int64) {
	t.Helper()
	for _, id := range ids {
		if _, err := f.mod.perms.GetRoleForUser(context.Background(), id); err != nil {
			t.Fatalf("warm %d: %v", id, err)
		}
	}
}

func TestSetNickname_RankChangedBeforeWrite(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	f.setRaw(ctx, t, nickMember, "before")
	f.warm(t, nickMod, nickMember)

	seedUserRole(t, f.database, nickMember, 2) // promoted to the actor's rank, cache untouched

	_, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("After"))
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("promoted target: want ErrForbidden, got %v", err)
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "before" {
		t.Fatalf("row = %q, want it unchanged", got)
	}
	// The same call at the db seam, where the refusal is made.
	if _, err := f.database.SetDisplayNameAsModerator(ctx, nickMod, nickMember, new("After")); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("db write: want ErrOutranked, got %v", err)
	}
}

func TestSetNickname_BitRemovedBeforeWrite(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	f.setRaw(ctx, t, nickMember, "before")
	f.warm(t, nickMod, nickMember)

	if _, err := f.database.ExecContext(ctx, `UPDATE roles SET permissions = ? WHERE id = 2`, permissions.ReadMessages); err != nil {
		t.Fatalf("strip bit: %v", err)
	}

	_, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("After"))
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("actor lost the bit: want ErrForbidden, got %v", err)
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "before" {
		t.Fatalf("row = %q, want it unchanged", got)
	}
}

func TestSetNickname_MultiRole_BitFromLowerHeldRole(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	// User 7's top role (senior, 70) has no bit; the lower held role (nick, 20)
	// does. The bit comes from the OR of held roles, rank from the top role.
	u, err := f.mod.SetNickname(ctx, nickMulti, nickMember, new("Via Lower Role"))
	if err != nil {
		t.Fatalf("SetNickname: %v", err)
	}
	if derefOr(u.DisplayName, "") != "Via Lower Role" {
		t.Fatalf("nickname = %v", u.DisplayName)
	}
	// Rank is still the top role (70): the 80-ranked mod is out of reach.
	if _, err := f.mod.SetNickname(ctx, nickMulti, nickMod, new("x")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("higher target: want ErrForbidden, got %v", err)
	}
	// Dropping the lower role takes the bit with it.
	if err := f.database.RemoveUserRole(ctx, nickMulti, 7); err != nil {
		t.Fatalf("RemoveUserRole: %v", err)
	}
	f.mod.perms.InvalidateUser(nickMulti)
	if _, err := f.mod.SetNickname(ctx, nickMulti, nickMember, new("y")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("after dropping the role: want ErrForbidden, got %v", err)
	}
}

// TestSetNickname_RacesSelfEdit: the moderator's write takes the same
// per-user profile lock as the member's own read-merge-write, so while that
// lock is held the moderator's write waits, and when both land neither is
// lost: the later writer wins on display_name, and the member's other column
// (about) survives the moderator's write.
func TestSetNickname_RacesSelfEdit(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	f.setRaw(ctx, t, nickMember, "before")

	release := f.users.profileLocks.lock(nickMember) // the member's edit is in flight

	type res struct {
		u   *db.User
		err error
	}
	done := make(chan res, 1)
	go func() {
		u, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("Moderated"))
		done <- res{u, err}
	}()

	select {
	case r := <-done:
		t.Fatalf("moderator write finished while the member's profile lock was held: %+v %v", r.u, r.err)
	case <-time.After(150 * time.Millisecond):
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "before" {
		t.Fatalf("row = %q while the lock was held, want it unchanged", got)
	}
	release()

	r := <-done
	if r.err != nil {
		t.Fatalf("SetNickname: %v", r.err)
	}
	if derefOr(r.u.DisplayName, "") != "Moderated" {
		t.Fatalf("returned row = %v, want the committed Moderated", r.u.DisplayName)
	}

	// Now interleave for real: many pairs of a member about-edit and a
	// moderator rename. With the lock the member's merge always reads the
	// committed nickname, so Moderated is never reverted.
	for i := range 20 {
		var wg sync.WaitGroup
		about := fmt.Sprintf("about %d", i)
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{About: &about}); err != nil {
				t.Errorf("UpdateProfile: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("Moderated")); err != nil {
				t.Errorf("SetNickname: %v", err)
			}
		}()
		wg.Wait()
		got, err := f.database.GetUserByID(ctx, nickMember)
		if err != nil || got == nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		if derefOr(got.DisplayName, "") != "Moderated" || derefOr(got.About, "") != about {
			t.Fatalf("round %d: nickname %q about %q, want Moderated and %q (a stale merge reverted a write)",
				i, derefOr(got.DisplayName, ""), derefOr(got.About, ""), about)
		}
	}
}

func TestSetNickname_AuditRowOldAndNew(t *testing.T) {
	f := newNicknameFixture(t)
	rec := audittest.Install(t, f.database)
	ctx := context.Background()

	if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("Bob")); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("Alice")); err != nil {
		t.Fatalf("second: %v", err)
	}
	if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, nil); err != nil {
		t.Fatalf("third: %v", err)
	}
	var details []string
	deadline := time.Now().Add(5 * time.Second)
	for len(details) < 3 && time.Now().Before(deadline) {
		details = details[:0]
		for _, e := range rec.Entries() {
			if e.Action != "nickname_change" {
				continue
			}
			if e.ActorID != nickMod || e.TargetType != "user" || e.TargetID != nickMember {
				t.Errorf("audit row actor/target = %d %s %d", e.ActorID, e.TargetType, e.TargetID)
			}
			details = append(details, e.Detail)
		}
		time.Sleep(time.Millisecond)
	}
	want := []string{`nickname (none) -> "Bob"`, `nickname "Bob" -> "Alice"`, `nickname "Alice" -> (none)`}
	if len(details) != len(want) {
		t.Fatalf("audit details = %q, want %q", details, want)
	}
	for i := range want {
		if details[i] != want[i] {
			t.Errorf("detail %d = %q, want %q", i, details[i], want[i])
		}
	}
}

func TestSetNickname_RateLimitedAfterAuthorization(t *testing.T) {
	f := newNicknameFixture(t)
	f.mod.limiter = auth.NewRateLimiter()
	ctx := context.Background()

	// A caller without the bit is refused every time and never spends budget.
	for i := range nicknameRateLimit + 5 {
		if _, err := f.mod.SetNickname(ctx, nickMember, nickOther, new("x")); !errors.Is(err, ErrForbidden) {
			t.Fatalf("no-bit call %d: want ErrForbidden, got %v", i, err)
		}
	}
	// The same actor id as a bit holder is unaffected by those refusals.
	for i := range nicknameRateLimit {
		if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new(fmt.Sprintf("n%d", i))); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new("one too many")); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("over the limit: want ErrRateLimited, got %v", err)
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != fmt.Sprintf("n%d", nicknameRateLimit-1) {
		t.Fatalf("a rate-limited call wrote %q", got)
	}
}
