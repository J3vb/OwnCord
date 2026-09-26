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
	if err != nil {
		t.Fatalf("100-rune multibyte name rejected: %v", err)
	}
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
	if err != nil {
		t.Fatalf("cleanChannelMeta: %v", err)
	}
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

	ch, err := svc.AdminCreateChannel(context.Background(), 7, AdminChannelCreate{Name: " lounge "}, nil)
	if err != nil {
		t.Fatalf("AdminCreateChannel: %v", err)
	}
	if ch.Type != "text" || ch.Name != "lounge" {
		t.Fatalf("created %q/%q, want lounge/text", ch.Name, ch.Type)
	}

	if _, err := svc.AdminCreateChannel(context.Background(), 7, AdminChannelCreate{Name: "x", Type: "forum"}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("bad type: err = %v, want ErrBadRequest", err)
	}

	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
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

	if _, err := svc.AdminUpdateChannel(context.Background(), 7, existing, AdminChannelUpdate{
		Name: "general", SlowMode: maxSlowModeSeconds + 1,
	}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("slow_mode over bound: err = %v, want ErrBadRequest", err)
	}

	updated, err := svc.AdminUpdateChannel(context.Background(), 7, existing, AdminChannelUpdate{
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
