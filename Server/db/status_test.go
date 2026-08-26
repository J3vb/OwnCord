package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The invisible model lives in three tiny pure functions, and every payload
// builder on the server delegates to one of them. Locking their behaviour here
// is what makes "an invisible user never leaks" a property of the codebase
// rather than of each individual call site.

func TestBroadcastStatus_MapsOnlyInvisible(t *testing.T) {
	cases := map[string]string{
		db.StatusOnline:    db.StatusOnline,
		db.StatusIdle:      db.StatusIdle,
		db.StatusDND:       db.StatusDND,
		db.StatusOffline:   db.StatusOffline,
		db.StatusInvisible: db.StatusOffline,
	}
	for in, want := range cases {
		if got := db.BroadcastStatus(in); got != want {
			t.Errorf("BroadcastStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStatusForViewer_OwnerSeesTruthOthersSeeOffline(t *testing.T) {
	const subject int64 = 7
	if got := db.StatusForViewer(db.StatusInvisible, subject, subject); got != db.StatusInvisible {
		t.Errorf("owner view = %q, want invisible", got)
	}
	if got := db.StatusForViewer(db.StatusInvisible, subject, 8); got != db.StatusOffline {
		t.Errorf("other view = %q, want offline", got)
	}
	// A non-invisible status is identical for both.
	if got := db.StatusForViewer(db.StatusDND, subject, 8); got != db.StatusDND {
		t.Errorf("other view of dnd = %q, want dnd", got)
	}
}

func TestConnectStatus_HonoursChoicesAndDefaultsOnline(t *testing.T) {
	cases := map[string]string{
		db.StatusIdle:      db.StatusIdle,
		db.StatusDND:       db.StatusDND,
		db.StatusInvisible: db.StatusInvisible,
		// offline carries no intent (it is also what a disconnect writes), so
		// it cannot mean "appear offline" — that is what invisible is for.
		db.StatusOffline: db.StatusOnline,
		db.StatusOnline:  db.StatusOnline,
		"":               db.StatusOnline,
		"bogus":          db.StatusOnline,
	}
	for in, want := range cases {
		if got := db.ConnectStatus(in); got != want {
			t.Errorf("ConnectStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidStatuses_AcceptsInvisible(t *testing.T) {
	if !db.ValidStatuses[db.StatusInvisible] {
		t.Error("invisible must be a settable status")
	}
	if db.ValidStatuses["afk"] {
		t.Error("unknown statuses must not be settable")
	}
}

func TestMemberSummary_ForViewer(t *testing.T) {
	m := db.MemberSummary{ID: 3, Username: "ghost", Status: db.StatusInvisible}
	if got := m.ForViewer(3).Status; got != db.StatusInvisible {
		t.Errorf("self view = %q, want invisible", got)
	}
	if got := m.ForViewer(4).Status; got != db.StatusOffline {
		t.Errorf("other view = %q, want offline", got)
	}
	// ForViewer must not mutate the receiver — it is called in a loop over a
	// shared slice.
	if m.Status != db.StatusInvisible {
		t.Errorf("receiver mutated to %q", m.Status)
	}
}

func TestMarkUserDisconnected_PreservesChosenStatus(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()

	onlineID, err := database.CreateUser(ctx, "went_online", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	dndID, err := database.CreateUser(ctx, "went_dnd", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	invisID, err := database.CreateUser(ctx, "went_invisible", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	_ = database.UpdateUserStatus(ctx, onlineID, db.StatusOnline)
	_ = database.UpdateUserStatus(ctx, dndID, db.StatusDND)
	_ = database.UpdateUserStatus(ctx, invisID, db.StatusInvisible)

	for _, id := range []int64{onlineID, dndID, invisID} {
		if err := database.MarkUserDisconnected(ctx, id); err != nil {
			t.Fatalf("MarkUserDisconnected(%d): %v", id, err)
		}
	}

	got := func(id int64) string {
		u, err := database.GetUserByID(ctx, id)
		if err != nil || u == nil {
			t.Fatalf("GetUserByID(%d): %v", id, err)
		}
		return u.Status
	}
	if s := got(onlineID); s != db.StatusOffline {
		t.Errorf("online -> %q, want offline", s)
	}
	// The whole point: the next connect reads this column, so a chosen status
	// has to still be there.
	if s := got(dndID); s != db.StatusDND {
		t.Errorf("dnd -> %q, want dnd preserved", s)
	}
	if s := got(invisID); s != db.StatusInvisible {
		t.Errorf("invisible -> %q, want invisible preserved", s)
	}
}

func TestUpdateUserCustomStatus_RoundTripAndClear(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	id, err := database.CreateUser(ctx, "statusy", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	text := "shipping phase 6"
	if err := database.UpdateUserCustomStatus(ctx, id, &text); err != nil {
		t.Fatalf("UpdateUserCustomStatus: %v", err)
	}
	u, _ := database.GetUserByID(ctx, id)
	if u.CustomStatus == nil || *u.CustomStatus != text {
		t.Fatalf("custom status = %v, want %q", u.CustomStatus, text)
	}

	if err := database.UpdateUserCustomStatus(ctx, id, nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	u, _ = database.GetUserByID(ctx, id)
	if u.CustomStatus != nil {
		t.Fatalf("custom status = %v, want nil after clear", *u.CustomStatus)
	}
}

func TestIsAvatarFileURL(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	id, err := database.CreateUser(ctx, "pfp", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	const url = "/api/v1/files/abc-123"
	if inUse, err := database.IsAvatarFileURL(ctx, url); err != nil || inUse {
		t.Fatalf("IsAvatarFileURL before = %v, %v; want false, nil", inUse, err)
	}

	avatar := url
	if err := database.UpdateUserProfile(ctx, id, "pfp", &avatar, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	if inUse, err := database.IsAvatarFileURL(ctx, url); err != nil || !inUse {
		t.Fatalf("IsAvatarFileURL in use = %v, %v; want true, nil", inUse, err)
	}

	// Replacing the avatar revokes the old file's public readability.
	other := "/api/v1/files/def-456"
	if err := database.UpdateUserProfile(ctx, id, "pfp", &other, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	if inUse, _ := database.IsAvatarFileURL(ctx, url); inUse {
		t.Error("replaced avatar must stop being publicly readable")
	}
}

func TestEffectiveDisplayName(t *testing.T) {
	name := "Ada L."
	empty := ""
	cases := []struct {
		user *db.User
		want string
	}{
		{&db.User{Username: "ada", DisplayName: &name}, "Ada L."},
		{&db.User{Username: "ada"}, "ada"},
		{&db.User{Username: "ada", DisplayName: &empty}, "ada"},
		{nil, ""},
	}
	for _, c := range cases {
		if got := c.user.EffectiveDisplayName(); got != c.want {
			t.Errorf("EffectiveDisplayName() = %q, want %q", got, c.want)
		}
	}
}

func TestUpdateUserProfile_WritesDisplayNameAndAbout(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	id, err := database.CreateUser(ctx, "bio", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	name, about := "Bio Person", "likes long walks"
	if err := database.UpdateUserProfile(ctx, id, "bio", nil, &name, &about); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	u, _ := database.GetUserByID(ctx, id)
	if u.DisplayName == nil || *u.DisplayName != name {
		t.Errorf("display_name = %v, want %q", u.DisplayName, name)
	}
	if u.About == nil || *u.About != about {
		t.Errorf("about = %v, want %q", u.About, about)
	}

	if err := database.UpdateUserProfile(ctx, id, "bio", nil, nil, nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	u, _ = database.GetUserByID(ctx, id)
	if u.DisplayName != nil || u.About != nil {
		t.Errorf("expected both cleared, got %v / %v", u.DisplayName, u.About)
	}
}
