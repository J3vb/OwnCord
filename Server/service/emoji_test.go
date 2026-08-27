package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newEmojiService builds an EmojiService over a hierarchy where exactly one
// non-admin role holds MANAGE_SERVER, so the gate can be shown to be that bit
// and not "any moderator":
//
//	user 1 -> Owner     (ADMINISTRATOR)
//	user 2 -> Admin     (MANAGE_SERVER, no ADMINISTRATOR)
//	user 3 -> Moderator (MANAGE_ROLES + KICK_MEMBERS, NO MANAGE_SERVER)
//	user 4 -> Member    (default role)
func newEmojiService(t *testing.T) (*EmojiService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner",
		Permissions: permissions.Administrator, Position: permissions.OwnerRolePosition})
	seedRole(t, database, &db.Role{ID: permissions.AdminRoleID, Name: "Admin",
		Permissions: permissions.ManageServer | permissions.ReadMessages, Position: 80})
	seedRole(t, database, &db.Role{ID: permissions.ModeratorRoleID, Name: "Moderator",
		Permissions: permissions.ManageRoles | permissions.KickMembers | permissions.ReadMessages, Position: 60})
	for userID, roleID := range map[int64]int64{
		1: permissions.OwnerRoleID,
		2: permissions.AdminRoleID,
		3: permissions.ModeratorRoleID,
		4: permissions.MemberRoleID,
	} {
		seedUser(t, database, &db.User{ID: userID})
		seedUserRole(t, database, userID, roleID)
	}
	checker := permissions.NewChecker(database)
	return NewEmojiService(database, NewPermissionService(database, checker)), database
}

// ─── Shortcode rules ─────────────────────────────────────────────────────────

func TestValidateShortcode_Accepts(t *testing.T) {
	cases := map[string]string{
		"wave":                               "wave",
		":wave:":                             "wave",
		"  :WAVE:  ":                         "wave",
		"PartyBlob":                          "partyblob",
		"a1":                                 "a1",
		"under_score":                        "under_score",
		"0123456789":                         "0123456789",
		strings.Repeat("x", MaxShortcodeLen): strings.Repeat("x", MaxShortcodeLen),
	}
	for in, want := range cases {
		got, err := ValidateShortcode(in)
		if err != nil {
			t.Errorf("ValidateShortcode(%q) = error %v, want %q", in, err, want)
			continue
		}
		if got != want {
			t.Errorf("ValidateShortcode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateShortcode_Rejects(t *testing.T) {
	bad := []string{
		"",                                     // empty
		"::",                                   // colons only
		"a",                                    // one character
		strings.Repeat("x", MaxShortcodeLen+1), // too long
		"has space",
		"dash-not-allowed",
		"dot.not.allowed",
		"emojié",
		"semi;colon",
		"wave:extra:",
		"</script>",
	}
	for _, in := range bad {
		if got, err := ValidateShortcode(in); err == nil {
			t.Errorf("ValidateShortcode(%q) = %q, want ErrBadRequest", in, got)
		} else if !errors.Is(err, ErrBadRequest) {
			t.Errorf("ValidateShortcode(%q) error = %v, want ErrBadRequest", in, err)
		}
	}
}

func TestEmojiImageURL(t *testing.T) {
	if got, want := EmojiImageURL(42), "/api/v1/emoji/42/image"; got != want {
		t.Errorf("EmojiImageURL(42) = %q, want %q", got, want)
	}
}

// ─── Permission gate ─────────────────────────────────────────────────────────

func TestEmojiCreate_RequiresManageServer(t *testing.T) {
	svc, _ := newEmojiService(t)

	// Moderator holds MANAGE_ROLES and KICK_MEMBERS but not MANAGE_SERVER.
	if _, err := svc.Create(context.Background(), 3, "wave", "stored-1", "image/png"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator Create error = %v, want ErrForbidden", err)
	}
	if _, err := svc.Create(context.Background(), 4, "wave", "stored-1", "image/png"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member Create error = %v, want ErrForbidden", err)
	}
	// MANAGE_SERVER without ADMINISTRATOR is enough.
	if _, err := svc.Create(context.Background(), 2, "wave", "stored-1", "image/png"); err != nil {
		t.Fatalf("admin Create: %v", err)
	}
	// ADMINISTRATOR bypasses the bit check.
	if _, err := svc.Create(context.Background(), 1, "party", "stored-2", "image/gif"); err != nil {
		t.Fatalf("owner Create: %v", err)
	}
}

func TestEmojiDelete_RequiresManageServer(t *testing.T) {
	svc, _ := newEmojiService(t)
	created, err := svc.Create(context.Background(), 1, "wave", "stored-1", "image/png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := svc.Delete(context.Background(), 4, created.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member Delete error = %v, want ErrForbidden", err)
	}
	// The refusal must not have removed anything.
	list, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("after refused delete len(list) = %d, want 1", len(list))
	}
}

func TestEmojiRequireManage_UnknownUserIsForbidden(t *testing.T) {
	svc, _ := newEmojiService(t)
	if err := svc.RequireManage(context.Background(), 9999); !errors.Is(err, ErrForbidden) {
		t.Fatalf("RequireManage(unknown) = %v, want ErrForbidden", err)
	}
}

func TestEmojiRequireManage_NilPermServiceIsForbidden(t *testing.T) {
	database := newTestDB(t)
	svc := NewEmojiService(database, nil)
	if err := svc.RequireManage(context.Background(), 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("RequireManage(nil perms) = %v, want ErrForbidden", err)
	}
}

// ─── Create / List / Delete ──────────────────────────────────────────────────

func TestEmojiCreate_NormalizesAndPersists(t *testing.T) {
	svc, database := newEmojiService(t)

	created, err := svc.Create(context.Background(), 1, ":WAVE:", "stored-1", "image/png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.Shortcode != "wave" {
		t.Errorf("Shortcode = %q, want %q", created.Shortcode, "wave")
	}
	if created.StoredAs != "stored-1" || created.MimeType != "image/png" {
		t.Errorf("StoredAs/MimeType = %q/%q, want stored-1/image/png", created.StoredAs, created.MimeType)
	}
	if created.UploadedBy != 1 {
		t.Errorf("UploadedBy = %d, want 1", created.UploadedBy)
	}

	got, err := database.GetEmojiByShortcode(context.Background(), "wave")
	if err != nil || got == nil {
		t.Fatalf("GetEmojiByShortcode = %v, %v", got, err)
	}
	if got.ID != created.ID {
		t.Errorf("round-tripped id = %d, want %d", got.ID, created.ID)
	}
}

func TestEmojiCreate_DuplicateShortcodeIsConflict(t *testing.T) {
	svc, _ := newEmojiService(t)
	if _, err := svc.Create(context.Background(), 1, "wave", "stored-1", "image/png"); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	// Different case, different file — same shortcode.
	_, err := svc.Create(context.Background(), 1, ":WaVe:", "stored-2", "image/gif")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate Create error = %v, want ErrConflict", err)
	}
}

// raceEmojiStore wraps a real *db.DB but always reports no existing emoji for
// the pre-insert shortcode check, so a concurrent CreateEmoji that already
// committed the same shortcode is only caught by the table's UNIQUE
// constraint at INSERT time -- exactly what happens when two CreateEmoji
// calls race past GetEmojiByShortcode before either INSERT commits.
type raceEmojiStore struct {
	*db.DB
}

func (f *raceEmojiStore) GetEmojiByShortcode(_ context.Context, _ string) (*db.Emoji, error) {
	return nil, nil
}

// TestEmojiCreate_RaceOnInsertIsConflict pins OC-0217: when the shortcode
// check races another Create and the row already exists by the time the
// INSERT runs, the resulting UNIQUE-constraint error from CreateEmoji must
// still surface as ErrConflict (matching the sequential duplicate-shortcode
// path), not ErrInternal.
func TestEmojiCreate_RaceOnInsertIsConflict(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner",
		Permissions: permissions.Administrator, Position: permissions.OwnerRolePosition})
	seedUser(t, database, &db.User{ID: 1})
	seedUserRole(t, database, 1, permissions.OwnerRoleID)

	checker := permissions.NewChecker(database)
	svc := NewEmojiService(&raceEmojiStore{DB: database}, NewPermissionService(database, checker))

	// Commit the shortcode directly, bypassing the service's own check, so the
	// table already holds :wave: when Create runs its (stubbed) check.
	if _, err := database.CreateEmoji(context.Background(), "wave", "stored-1", "image/png", 1); err != nil {
		t.Fatalf("seed CreateEmoji: %v", err)
	}

	_, err := svc.Create(context.Background(), 1, "wave", "stored-2", "image/gif")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("raced Create error = %v, want ErrConflict", err)
	}
	if errors.Is(err, ErrInternal) {
		t.Fatalf("raced Create error = %v, must not be ErrInternal", err)
	}
}

func TestEmojiCreate_RejectsBadShortcodeBeforeInsert(t *testing.T) {
	svc, _ := newEmojiService(t)
	if _, err := svc.Create(context.Background(), 1, "no spaces", "stored-1", "image/png"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("Create error = %v, want ErrBadRequest", err)
	}
	list, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("len(list) = %d, want 0", len(list))
	}
}

func TestEmojiCreate_EnforcesCountCap(t *testing.T) {
	svc, database := newEmojiService(t)
	// Insert the cap directly — going through Create MaxEmojiCount times is a
	// slower way of arriving at the same state.
	for i := range MaxEmojiCount {
		if _, err := database.CreateEmoji(context.Background(),
			fmt.Sprintf("e%d", i), fmt.Sprintf("stored-%d", i), "image/png", 1); err != nil {
			t.Fatalf("seed emoji %d: %v", i, err)
		}
	}
	_, err := svc.Create(context.Background(), 1, "onemore", "stored-x", "image/png")
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("over-cap Create error = %v, want ErrBadRequest", err)
	}
}

func TestEmojiList_OrderedByShortcode(t *testing.T) {
	svc, _ := newEmojiService(t)
	for _, sc := range []string{"zebra", "apple", "mango"} {
		if _, err := svc.Create(context.Background(), 1, sc, "stored-"+sc, "image/png"); err != nil {
			t.Fatalf("Create(%s): %v", sc, err)
		}
	}
	list, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := make([]string, 0, len(list))
	for _, e := range list {
		got = append(got, e.Shortcode)
	}
	want := []string{"apple", "mango", "zebra"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("List order = %v, want %v", got, want)
	}
}

func TestEmojiDelete_RemovesAndReturnsStorageID(t *testing.T) {
	svc, _ := newEmojiService(t)
	created, err := svc.Create(context.Background(), 1, "wave", "stored-1", "image/png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	removed, err := svc.Delete(context.Background(), 1, created.ID)
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if removed.StoredAs != "stored-1" {
		t.Errorf("removed.StoredAs = %q, want stored-1", removed.StoredAs)
	}

	list, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("len(list) after delete = %d, want 0", len(list))
	}
	// The shortcode is free again.
	if _, err := svc.Create(context.Background(), 1, "wave", "stored-2", "image/png"); err != nil {
		t.Fatalf("re-Create after delete: %v", err)
	}
}

func TestEmojiDelete_UnknownIDIsNotFound(t *testing.T) {
	svc, _ := newEmojiService(t)
	if _, err := svc.Delete(context.Background(), 1, 4242); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete(unknown) = %v, want ErrNotFound", err)
	}
}

func TestEmojiGet_UnknownIDIsNotFound(t *testing.T) {
	svc, _ := newEmojiService(t)
	if _, err := svc.Get(context.Background(), 4242); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(unknown) = %v, want ErrNotFound", err)
	}
}

func TestEmojiCreate_WritesAudit(t *testing.T) {
	svc, database := newEmojiService(t)
	created, err := svc.Create(context.Background(), 1, "wave", "stored-1", "image/png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := svc.Delete(context.Background(), 1, created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	entries, err := database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.TargetType == "emoji" {
			seen[e.Action] = true
		}
	}
	for _, action := range []string{"emoji_create", "emoji_delete"} {
		if !seen[action] {
			t.Errorf("no %s audit entry (saw %v)", action, seen)
		}
	}
}
