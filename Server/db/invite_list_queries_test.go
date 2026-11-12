package db_test

import (
	"context"
	"testing"
	"time"
)

func TestListInvites_LiveDeadAndCursor(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := mustCreateUser(t, database, "inviter", "hash", 4)

	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	liveOld, _ := database.CreateInvite(ctx, uid, 0, nil)
	liveTimed, _ := database.CreateInvite(ctx, uid, 5, &future)
	revoked, _ := database.CreateInvite(ctx, uid, 0, nil)
	expired, _ := database.CreateInvite(ctx, uid, 0, &past)
	usedUp, _ := database.CreateInvite(ctx, uid, 1, nil)
	mustDo(t, "RevokeInvite", database.RevokeInvite(ctx, revoked))
	mustDo(t, "UseInviteAtomic", database.UseInviteAtomic(ctx, usedUp))

	live, err := database.ListInvites(ctx, false, 0, 10)
	mustDo(t, "ListInvites live", err)
	if len(live) != 2 || live[0].Code != liveTimed || live[1].Code != liveOld {
		t.Fatalf("live = %+v, want [%s %s] newest first", live, liveTimed, liveOld)
	}
	if live[0].CreatorUsername != "inviter" || live[0].MaxUses == nil || *live[0].MaxUses != 5 || live[0].ExpiresAt == nil {
		t.Errorf("live row not fully mapped: %+v", live[0])
	}

	dead, err := database.ListInvites(ctx, true, 0, 10)
	mustDo(t, "ListInvites dead", err)
	if len(dead) != 3 || dead[0].Code != usedUp || dead[1].Code != expired || dead[2].Code != revoked {
		t.Fatalf("dead = %+v, want [used up, expired, revoked]", dead)
	}
	if !dead[2].Revoked || dead[0].Uses != 1 {
		t.Errorf("dead rows not mapped: %+v %+v", dead[0], dead[2])
	}

	// Cursor: strictly below the given id, limited.
	page, err := database.ListInvites(ctx, true, dead[0].ID, 1)
	mustDo(t, "ListInvites dead page", err)
	if len(page) != 1 || page[0].Code != expired {
		t.Fatalf("page after first dead = %+v, want the expired invite", page)
	}
	none, err := database.ListInvites(ctx, true, dead[2].ID, 10)
	mustDo(t, "ListInvites dead end", err)
	if len(none) != 0 {
		t.Fatalf("past the last dead invite: %+v", none)
	}
	noneLive, err := database.ListInvites(ctx, false, live[1].ID, 10)
	mustDo(t, "ListInvites live end", err)
	if len(noneLive) != 0 {
		t.Fatalf("past the last live invite: %+v", noneLive)
	}
}

func TestListInvites_EmptyAndClosedDB(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	for _, dead := range []bool{false, true} {
		got, err := database.ListInvites(ctx, dead, 0, 10)
		mustDo(t, "ListInvites empty", err)
		if got == nil || len(got) != 0 {
			t.Fatalf("dead=%v: want empty non-nil slice, got %#v", dead, got)
		}
	}
	mustDo(t, "Close", database.Close())
	for _, dead := range []bool{false, true} {
		if _, err := database.ListInvites(ctx, dead, 0, 10); err == nil {
			t.Errorf("dead=%v: want an error on a closed database", dead)
		}
	}
	if _, err := database.GetInviteByID(ctx, 1); err == nil {
		t.Error("GetInviteByID on a closed database: want an error")
	}
}

func TestGetInviteByID(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := mustCreateUser(t, database, "byid", "hash", 4)
	code, _ := database.CreateInvite(ctx, uid, 3, nil)
	byCode, err := database.GetInvite(ctx, code)
	mustDo(t, "GetInvite", err)

	got, err := database.GetInviteByID(ctx, byCode.ID)
	mustDo(t, "GetInviteByID", err)
	if got == nil || got.Code != code || got.CreatedBy != uid || got.MaxUses == nil || *got.MaxUses != 3 || got.Revoked {
		t.Fatalf("GetInviteByID = %+v", got)
	}
	missing, err := database.GetInviteByID(ctx, 99999)
	mustDo(t, "GetInviteByID missing", err)
	if missing != nil {
		t.Fatalf("missing id returned %+v", missing)
	}
}
