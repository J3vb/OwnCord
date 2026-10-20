package db_test

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Profile banners (WP 6.11b). A banner is an unlinked attachment that
// users.banner_id names; the four file-liveness sites must all keep it alive
// and refuse to link it to a message while it is named.

func setBanner(t *testing.T, f groupRowFixture, user int64, id *string, color *string) {
	t.Helper()
	u, err := f.database.GetUserByID(context.Background(), user)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if err := f.database.UpdateUserProfile(context.Background(), user, u.Username, u.Avatar, u.DisplayName, u.About, id, color); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
}

func TestOrphanSweep_KeepsLiveBanner(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "banner-old", f.alice)
	seedIconAttachment(t, f.database, "banner-live", f.alice)
	seedIconAttachment(t, f.database, "plain", f.alice)
	setBanner(t, f, f.alice, new("banner-old"), nil)
	setBanner(t, f, f.alice, new("banner-live"), nil)

	swept, err := f.database.DeleteOrphanedAttachments(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	got := map[string]bool{}
	for _, s := range swept {
		got[s] = true
	}
	if got["stored-banner-live"] {
		t.Errorf("the sweep deleted the live banner")
	}
	if !got["stored-banner-old"] || !got["stored-plain"] {
		t.Errorf("the sweep kept a replaced banner or an orphan: swept %v", swept)
	}
}

func TestDiscardUnlinked_KeepsLiveBanner(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "banner-live", f.alice)
	setBanner(t, f, f.alice, new("banner-live"), nil)
	if _, found, err := f.database.DiscardUnlinkedAttachment(ctx, "banner-live", f.alice); err != nil || found {
		t.Errorf("discard of the live banner = found %v, %v; want kept", found, err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET banner_id = NULL WHERE id = ?`, f.alice); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, found, err := f.database.DiscardUnlinkedAttachment(ctx, "banner-live", f.alice); err != nil || !found {
		t.Errorf("discard of a cleared banner = found %v, %v; want discarded", found, err)
	}
}

func TestLinkAttachments_RefusesLiveBanner(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "banner-live", f.alice)
	setBanner(t, f, f.alice, new("banner-live"), nil)
	msgID, err := f.database.CreateMessage(ctx, f.group, f.alice, "carrier", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	linked, err := f.database.LinkAttachmentsToMessage(ctx, msgID, f.alice, []string{"banner-live"})
	if err != nil || len(linked) != 0 {
		t.Errorf("link = %v, %v; want the live banner skipped", linked, err)
	}
	if att, _ := f.database.GetAttachmentByID(ctx, "banner-live"); att == nil || att.MessageID != nil {
		t.Errorf("the live banner was linked to a message")
	}
}

func TestIsBannerFile_OnlyWhileNamed(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "b1", f.alice)
	seedIconAttachment(t, f.database, "b2", f.alice)
	is := func(id string) bool {
		t.Helper()
		ok, err := f.database.IsBannerFile(ctx, id)
		if err != nil {
			t.Fatalf("IsBannerFile: %v", err)
		}
		return ok
	}
	if is("b1") {
		t.Fatal("an unnamed file is not a banner")
	}
	setBanner(t, f, f.alice, new("b1"), nil)
	if !is("b1") || is("b2") {
		t.Errorf("b1 must be a banner and b2 not")
	}
	setBanner(t, f, f.alice, new("b2"), nil)
	if is("b1") || !is("b2") {
		t.Errorf("a replaced banner must stop being one")
	}
}

// Both banner columns are in the migration-069 trigger, so the cached roster
// refreshes when either changes, and not when a write changes nothing.
func TestMemberGeneration_MovesOnBannerWrite(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "b1", f.alice)
	gen := func() int64 {
		t.Helper()
		g, err := f.database.MemberGeneration(ctx)
		if err != nil {
			t.Fatalf("MemberGeneration: %v", err)
		}
		return g
	}
	steps := []struct {
		name  string
		id    *string
		color *string
		moves bool
	}{
		{"colour", nil, new("#abcdef"), true},
		{"colour rewrite", nil, new("#abcdef"), false},
		{"image", new("b1"), new("#abcdef"), true},
		{"image rewrite", new("b1"), new("#abcdef"), false},
	}
	for _, s := range steps {
		before := gen()
		setBanner(t, f, f.alice, s.id, s.color)
		if moved := gen() != before; moved != s.moves {
			t.Errorf("%s: generation moved = %v, want %v", s.name, moved, s.moves)
		}
	}
}

func TestListMembers_CarriesBannerOnlyWhenSet(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "b1", f.alice)
	setBanner(t, f, f.alice, new("b1"), new("#112233"))
	members, err := f.database.ListMembers(ctx)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	for _, m := range members {
		banner, color := m.BannerOf()
		switch m.ID {
		case f.alice:
			if banner == nil || *banner != "/api/v1/files/b1" || color == nil || *color != "#112233" {
				t.Errorf("alice banner = %v / %v", banner, color)
			}
		default:
			if banner != nil || color != nil || m.MemberBanner != nil {
				t.Errorf("member %d has banner fields %v / %v, want none", m.ID, banner, color)
			}
		}
	}
}

// The ratchet: every statement that decides file liveness by "this attachment
// is some user's avatar" must also name banner_id, so a future site cannot
// forget banners the way a new avatar-aware query once could forget dm_icon.
func TestFileLiveness_EverySiteNamesBanner(t *testing.T) {
	liveness := regexp.MustCompile(`u\.avatar\s*=\s*'/api/v1/files/'`)
	var sites, missing []string
	check := func(path string, statements []string) {
		for _, st := range statements {
			if !liveness.MatchString(st) {
				continue
			}
			sites = append(sites, path)
			if !strings.Contains(st, "banner_id") {
				missing = append(missing, path)
			}
		}
	}
	sqlFiles, _ := filepath.Glob("queries/sqlite/*.sql")
	for _, p := range sqlFiles {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		check(p, strings.Split(string(b), "-- name:"))
	}
	goFiles, _ := filepath.Glob("*.go")
	for _, p := range goFiles {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		check(p, strings.Split(string(b), "`")) // raw-string SQL texts
	}
	// DiscardUnlinkedAttachment, DeleteOrphanedAttachments, linkAttachmentsToMessage.
	if len(sites) < 3 {
		t.Fatalf("found %d avatar-liveness sites (%v), want at least 3: the scan is not reaching them", len(sites), sites)
	}
	if len(missing) > 0 {
		t.Errorf("avatar-liveness statements that do not name banner_id: %v", missing)
	}
}
