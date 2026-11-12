package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The channel family's service-level characterization (B3-8): S-03's
// rune/normalization contract and S-04's one non-DM resolution policy,
// pinned at the seam the admin handlers delegate to.

func newChannelAdminService(t *testing.T) (*ChannelService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	return NewChannelService(database, NewPermissionService(database, nil)), database
}

// ─── S-03: rune/normalization contract ───────────────────────────────────────

func TestChannelMeta_NameCountsRunesNotBytes(t *testing.T) {
	// 100 two-byte runes = 200 bytes: legal by the contract, which counts
	// runes; a byte-counting bound would reject it.
	name100 := strings.Repeat("é", 100)
	meta, err := cleanChannelMeta(name100, "", "")
	mustDo(t, "100-rune multibyte name rejected", err)
	if meta.Name != name100 {
		t.Fatalf("name mangled: %q", meta.Name)
	}
	if _, err := cleanChannelMeta(strings.Repeat("é", 101), "", ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("101-rune name: err = %v, want ErrBadRequest", err)
	}
}

func TestChannelMeta_TopicAndCategoryBounds(t *testing.T) {
	if _, err := cleanChannelMeta("ok", strings.Repeat("t", MaxChannelTopicLen), ""); err != nil {
		t.Fatalf("topic at the bound rejected: %v", err)
	}
	if _, err := cleanChannelMeta("ok", strings.Repeat("t", MaxChannelTopicLen+1), ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("topic over the bound: err = %v, want ErrBadRequest", err)
	}
	if _, err := cleanChannelMeta("ok", "", strings.Repeat("c", MaxChannelCategoryLen+1)); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("category over the bound: err = %v, want ErrBadRequest", err)
	}
}

func TestChannelMeta_SanitizesAndTrimsLikeEverySidebarField(t *testing.T) {
	meta, err := cleanChannelMeta("  <b>general</b>  ", " topic <i>x</i> ", "  Chat  ")
	mustDo(t, "cleanChannelMeta", err)
	if meta.Name != "general" {
		t.Errorf("name = %q, want %q", meta.Name, "general")
	}
	if meta.Topic != "topic x" {
		t.Errorf("topic = %q, want %q", meta.Topic, "topic x")
	}
	if meta.Category != "Chat" {
		t.Errorf("category = %q, want %q", meta.Category, "Chat")
	}
}

func TestChannelMeta_EmptyNameAfterCleaningIsRequired(t *testing.T) {
	for _, name := range []string{"", "   ", "<b></b>"} {
		if _, err := cleanChannelMeta(name, "", ""); !errors.Is(err, ErrBadRequest) {
			t.Errorf("name %q: err = %v, want ErrBadRequest", name, err)
		}
	}
}

func TestChannelMeta_SharesTheGroupDMNameCap(t *testing.T) {
	// The DM code has always documented MaxGroupDMNameLen as matching the
	// channel name cap; S-03 makes that a checked fact, not a comment.
	if MaxChannelNameLen != MaxGroupDMNameLen {
		t.Fatalf("MaxChannelNameLen (%d) != MaxGroupDMNameLen (%d)", MaxChannelNameLen, MaxGroupDMNameLen)
	}
}

// ─── S-04: one non-DM resolution policy ──────────────────────────────────────

func TestResolveGuildChannel_MissingAndDMAreIndistinguishable(t *testing.T) {
	svc, database := newChannelAdminService(t)
	seedChannel(t, database, &db.Channel{ID: 30, Name: "dm-room", Type: "dm"})
	seedChannel(t, database, &db.Channel{ID: 31, Name: "general", Type: "text"})

	_, missErr := svc.ResolveGuildChannel(context.Background(), 999)
	_, dmErr := svc.ResolveGuildChannel(context.Background(), 30)
	if !errors.Is(missErr, ErrNotFound) || !errors.Is(dmErr, ErrNotFound) {
		t.Fatalf("miss=%v dm=%v, want ErrNotFound for both", missErr, dmErr)
	}
	// The DM answer must not confirm the id is a private conversation: the
	// two error strings are identical (A-2026-08-02).
	if missErr.Error() != dmErr.Error() {
		t.Fatalf("responses differ: missing=%q dm=%q", missErr, dmErr)
	}

	ch, err := svc.ResolveGuildChannel(context.Background(), 31)
	if err != nil || ch == nil || ch.ID != 31 {
		t.Fatalf("guild channel: %v, %v", ch, err)
	}
	if _, err := svc.ResolveGuildChannel(context.Background(), 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("id 0: err = %v, want ErrBadRequest", err)
	}
}

// ─── Admin CRUD through the service ──────────────────────────────────────────

func TestAdminCreateChannel_DefaultsTypeValidatesAndAudits(t *testing.T) {
	svc, database := newChannelAdminService(t)

	ch, _, err := svc.AdminCreateChannel(context.Background(), 7, AdminChannelCreate{Name: " lounge "}, nil)
	mustDo(t, "AdminCreateChannel", err)
	if ch.Type != "text" || ch.Name != "lounge" {
		t.Fatalf("created %q/%q, want lounge/text", ch.Name, ch.Type)
	}

	if _, _, err := svc.AdminCreateChannel(context.Background(), 7, AdminChannelCreate{Name: "x", Type: "stage"}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("bad type: err = %v, want ErrBadRequest", err)
	}
	forum, _, err := svc.AdminCreateChannel(context.Background(), 7, AdminChannelCreate{Name: "ideas", Type: "forum"}, nil)
	if err != nil {
		t.Fatalf("forum type: err = %v, want accepted", err)
	}
	if forum.Type != "forum" || forum.Forum == nil {
		t.Fatalf("forum created as %q with settings %v, want a forum carrying its settings", forum.Type, forum.Forum)
	}

	entries := mustGetAuditLog(t, database, 10, 0)
	found := false
	for _, e := range entries {
		if e.Action == "channel_create" && e.ActorID == 7 {
			found = true
		}
	}
	if !found {
		t.Fatal("no channel_create audit row")
	}
}

func TestAdminUpdateChannel_NumericBoundsAndNSFWAudit(t *testing.T) {
	svc, database := newChannelAdminService(t)
	seedChannel(t, database, &db.Channel{ID: 40, Name: "general", Type: "text"})
	existing, _ := svc.ResolveGuildChannel(context.Background(), 40)

	if _, _, err := svc.AdminUpdateChannel(context.Background(), 7, existing, AdminChannelUpdate{
		Name: "general", SlowMode: maxSlowModeSeconds + 1,
	}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("slow_mode over bound: err = %v, want ErrBadRequest", err)
	}

	updated, _, err := svc.AdminUpdateChannel(context.Background(), 7, existing, AdminChannelUpdate{
		Name: "general", NSFW: true,
	}, nil)
	if err != nil || !updated.NSFW {
		t.Fatalf("nsfw update: %v, %v", updated, err)
	}
	entries, _ := database.GetAuditLog(context.Background(), 10, 0)
	found := false
	for _, e := range entries {
		if e.Action == "channel_update" && strings.Contains(e.Detail, "(marked NSFW)") {
			found = true
		}
	}
	if !found {
		t.Fatal("nsfw transition not in the audit detail")
	}
}

func TestAdminDeleteChannel_ArchivesBeforeEviction(t *testing.T) {
	svc, database := newChannelAdminService(t)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "doomed", Type: "voice"})
	existing, _ := svc.ResolveGuildChannel(context.Background(), 50)

	// OC-0035's ordering pin: when the eviction callback runs, archived=1 has
	// already committed, so a voice_join racing the delete is refused by the
	// archived gate instead of orphaning its session.
	sawArchived := false
	archivedRow, err := svc.AdminDeleteChannel(context.Background(), 7, existing, func(chID int64) {
		if ch, gErr := database.GetChannel(context.Background(), chID); gErr == nil && ch != nil && ch.Archived {
			sawArchived = true
		}
	})
	if err != nil || archivedRow != nil {
		t.Fatalf("AdminDeleteChannel: row=%v err=%v", archivedRow, err)
	}
	if !sawArchived {
		t.Fatal("eviction callback ran before the archive committed")
	}
	if ch, _ := database.GetChannel(context.Background(), 50); ch != nil {
		t.Fatalf("channel row survived the delete: %+v", ch)
	}
}

// ─── Channel name uniqueness ─────────────────────────────────────────────────

func TestAdminChannel_DuplicateNameIsConflict(t *testing.T) {
	svc, _ := newChannelAdminService(t)
	ctx := context.Background()
	first, _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "Lobby", Type: "text", Category: "Chat"}, nil)
	mustDo(t, "create", err)
	if _, _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "LOBBY", Type: "text", Category: "Chat"}, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate create: err = %v, want ErrConflict", err)
	}
	second, _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "lobby", Type: "voice", Category: "Chat"}, nil)
	mustDo(t, "same name, other type", err)
	third, _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "hall", Type: "text", Category: "Chat"}, nil)
	mustDo(t, "create", err)
	if _, _, err := svc.AdminUpdateChannel(ctx, 1, third, AdminChannelUpdate{Name: "lobby", Category: new("Chat")}, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("rename onto a sibling: err = %v, want ErrConflict", err)
	}
	if _, _, err := svc.AdminUpdateChannel(ctx, 1, first, AdminChannelUpdate{Name: "lobby", Category: new("Chat")}, nil); err != nil {
		t.Fatalf("case-only rename of itself: %v", err)
	}
	if _, _, err := svc.AdminUpdateChannel(ctx, 1, second, AdminChannelUpdate{Name: "lobby", Category: new("Chat"), Topic: "t"}, nil); err != nil {
		t.Fatalf("unchanged name on another type: %v", err)
	}
}

// fullUpdateFrom builds the request a PATCH handler pre-fills from the row it
// read: every field at the snapshot's value, ready to have the body laid over it.
func fullUpdateFrom(ch *db.Channel) AdminChannelUpdate {
	return AdminChannelUpdate{
		Name: ch.Name, Topic: ch.Topic, CategoryID: ch.CategoryID, KeepCategory: true,
		SlowMode: ch.SlowMode, Position: ch.Position, Archived: ch.Archived, NSFW: ch.NSFW,
		VoiceMaxUsers: ch.VoiceMaxUsers, VoiceMaxVideo: ch.VoiceMaxVideo,
	}
}

func TestAdminUpdateChannel_StaleSnapshotKeepsAConcurrentEdit(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	other := f.newChannel(t, "gamma", f.cat.ID)
	snap := *f.a

	// Edit A commits first, then edit B (built from the same snapshot) names only
	// a position.
	a := fullUpdateFrom(&snap)
	a.Name, a.Topic, a.SlowMode, a.NSFW, a.Archived = "renamed", "new topic", 30, true, true
	_, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, a, nil)
	mustDo(t, "edit A", err)

	var before db.Channel
	b := fullUpdateFrom(&snap)
	b.Position += 5
	b.Before = &before
	got, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, b, nil)
	mustDo(t, "edit B", err)

	if got.Name != "renamed" || got.Topic != "new topic" || got.SlowMode != 30 || !got.NSFW || !got.Archived {
		t.Errorf("after B: name=%q topic=%q slow=%d nsfw=%v archived=%v, want A's edit kept",
			got.Name, got.Topic, got.SlowMode, got.NSFW, got.Archived)
	}
	if got.Position != snap.Position+5 {
		t.Errorf("position = %d, want B's %d", got.Position, snap.Position+5)
	}
	if got.CategoryID != f.cat.ID || other.CategoryID != f.cat.ID {
		t.Errorf("category = %d, want %d", got.CategoryID, f.cat.ID)
	}
	if !before.Archived || before.Name != "renamed" {
		t.Errorf("Before = %+v, want the row A left (archived, renamed)", before)
	}
}

func TestAdminUpdateChannel_StaleSnapshotStillAppliesWhatTheRequestChanged(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	snap := *f.a

	a := fullUpdateFrom(&snap)
	a.Name, a.Topic = "renamed", "kept topic"
	_, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, a, nil)
	mustDo(t, "edit A", err)

	// B renames too: its own change wins for the name, A's topic stays.
	b := fullUpdateFrom(&snap)
	b.Name = "second"
	got, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, b, nil)
	mustDo(t, "edit B", err)
	if got.Name != "second" || got.Topic != "kept topic" {
		t.Errorf("after B: name=%q topic=%q, want \"second\" and \"kept topic\"", got.Name, got.Topic)
	}
}

// otherCategoryWith creates a second category holding one channel named name.
func (f *catPermFixture) otherCategoryWith(t *testing.T, name string) *db.ChannelCategory {
	t.Helper()
	change, err := f.svc.CreateCategory(context.Background(), 1, "Other")
	mustDo(t, "CreateCategory", err)
	f.newChannel(t, name, change.Category.ID)
	return change.Category
}

func (f *catPermFixture) requireNameAndCategory(t *testing.T, id int64, name string, categoryID int64) {
	t.Helper()
	got, err := f.database.GetChannel(context.Background(), id)
	if err != nil || got == nil || got.Name != name || got.CategoryID != categoryID {
		t.Errorf("channel = %+v, %v; want %q in category %d", got, err, name, categoryID)
	}
}

// A move built from a snapshot keeps a rename that landed since. The name the
// move was checked with is then not the name it would write, so the name is
// checked again inside the write.
func TestAdminUpdateChannel_StaleMoveIsRefusedWhenTheKeptNameIsTakenThere(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	other := f.otherCategoryWith(t, "lobby")
	snap := *f.a

	a := fullUpdateFrom(&snap)
	a.Name = "Lobby"
	_, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, a, nil)
	mustDo(t, "edit A (rename)", err)

	b := fullUpdateFrom(&snap)
	b.CategoryID, b.KeepCategory = other.ID, false
	if _, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, b, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("edit B (move) = %v, want ErrConflict: the kept name is taken in the target category", err)
	}
	f.requireNameAndCategory(t, snap.ID, "Lobby", f.cat.ID)
}

// The mirror: a rename built from a snapshot keeps a move that landed since.
func TestAdminUpdateChannel_StaleRenameIsRefusedWhenTheNameIsTakenInTheKeptCategory(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	other := f.otherCategoryWith(t, "lobby")
	snap := *f.a

	a := fullUpdateFrom(&snap)
	a.CategoryID, a.KeepCategory = other.ID, false
	_, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, a, nil)
	mustDo(t, "edit A (move)", err)

	b := fullUpdateFrom(&snap)
	b.Name = "lobby"
	if _, _, err := f.svc.AdminUpdateChannel(ctx, 7, &snap, b, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("edit B (rename) = %v, want ErrConflict: the name is taken in the category the channel moved to", err)
	}
	f.requireNameAndCategory(t, snap.ID, snap.Name, other.ID)
}

func TestRequireChannelNameFree_IgnoresDMNames(t *testing.T) {
	svc, database := newChannelAdminService(t)
	ctx := context.Background()
	a, err := database.CreateUser(ctx, "namefree-a", "hash", 4)
	mustDo(t, "CreateUser a", err)
	b, err := database.CreateUser(ctx, "namefree-b", "hash", 4)
	mustDo(t, "CreateUser b", err)
	c, err := database.CreateUser(ctx, "namefree-c", "hash", 4)
	mustDo(t, "CreateUser c", err)
	if _, err := database.CreateGroupDMChannel(ctx, "lobby", a, []int64{a, b, c}); err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	if _, _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "lobby", Type: "text"}, nil); err != nil {
		t.Fatalf("a guild channel may share a group DM's name: %v", err)
	}
}
