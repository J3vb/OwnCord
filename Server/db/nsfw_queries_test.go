package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// nsfwChannel seeds a plain channel and flips its nsfw flag on.
func nsfwChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id := seedChannel(t, database, name)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = 1 WHERE id = ?`, id); err != nil {
		t.Fatalf("nsfwChannel(%q): %v", name, err)
	}
	return id
}

func TestAcknowledgeNSFW_RevokeAndHasNSFWAcknowledgement(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "acker")
	chID := nsfwChannel(t, database, "labelled")

	if ok, err := database.HasNSFWAcknowledgement(ctx, uid, chID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement before ack = (%v, %v), want (false, nil)", ok, err)
	}

	if err := database.AcknowledgeNSFW(ctx, uid, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	if ok, err := database.HasNSFWAcknowledgement(ctx, uid, chID); err != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement after ack = (%v, %v), want (true, nil)", ok, err)
	}

	// INSERT OR IGNORE: acknowledging twice is a no-op, not an error.
	if err := database.AcknowledgeNSFW(ctx, uid, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW (second time): %v", err)
	}

	if err := database.RevokeNSFW(ctx, uid, chID); err != nil {
		t.Fatalf("RevokeNSFW: %v", err)
	}
	if ok, err := database.HasNSFWAcknowledgement(ctx, uid, chID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after revoke = (%v, %v), want (false, nil)", ok, err)
	}

	// Revoking a row that does not exist is a no-op, not an error.
	if err := database.RevokeNSFW(ctx, uid, chID); err != nil {
		t.Fatalf("RevokeNSFW (already gone): %v", err)
	}
}

func TestListNSFWAcknowledgedUserIDs(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	chID := nsfwChannel(t, database, "labelled")
	other := nsfwChannel(t, database, "other-labelled")
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	carol := seedUser(t, database, "carol")

	if err := database.AcknowledgeNSFW(ctx, alice, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW(alice): %v", err)
	}
	if err := database.AcknowledgeNSFW(ctx, bob, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW(bob): %v", err)
	}
	// carol acknowledges a DIFFERENT channel — must not show up for chID.
	if err := database.AcknowledgeNSFW(ctx, carol, other); err != nil {
		t.Fatalf("AcknowledgeNSFW(carol): %v", err)
	}

	got, err := database.ListNSFWAcknowledgedUserIDs(ctx, chID)
	if err != nil {
		t.Fatalf("ListNSFWAcknowledgedUserIDs: %v", err)
	}
	want := map[int64]bool{alice: true, bob: true}
	if len(got) != len(want) {
		t.Fatalf("ListNSFWAcknowledgedUserIDs = %v, want exactly %v", got, want)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("ListNSFWAcknowledgedUserIDs returned unexpected id %d", id)
		}
	}

	empty, err := database.ListNSFWAcknowledgedUserIDs(ctx, other+1000)
	if err != nil {
		t.Fatalf("ListNSFWAcknowledgedUserIDs(unknown channel): %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("ListNSFWAcknowledgedUserIDs(unknown channel) = %v, want empty", empty)
	}
}

func TestDeleteNSFWAcknowledgementsForChannel(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	chID := nsfwChannel(t, database, "labelled")
	other := nsfwChannel(t, database, "other-labelled")
	alice := seedUser(t, database, "alice")

	if err := database.AcknowledgeNSFW(ctx, alice, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW(chID): %v", err)
	}
	if err := database.AcknowledgeNSFW(ctx, alice, other); err != nil {
		t.Fatalf("AcknowledgeNSFW(other): %v", err)
	}

	if err := database.DeleteNSFWAcknowledgementsForChannel(ctx, chID); err != nil {
		t.Fatalf("DeleteNSFWAcknowledgementsForChannel: %v", err)
	}

	if ok, err := database.HasNSFWAcknowledgement(ctx, alice, chID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement(chID) after clear = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := database.HasNSFWAcknowledgement(ctx, alice, other); err != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement(other) after clearing chID = (%v, %v), want (true, nil) — must not touch a different channel", ok, err)
	}
}

// TestNSFW_ChannelDeletionCascades proves the channel half of the row's
// lifecycle needs no application code: ON DELETE CASCADE on channel_id takes
// the acknowledgement with it, the same shape channel_retention (migration
// 039) already uses.
func TestNSFW_ChannelDeletionCascades(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	chID := nsfwChannel(t, database, "doomed")
	alice := seedUser(t, database, "alice")

	if err := database.AcknowledgeNSFW(ctx, alice, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}

	if err := database.AdminDeleteChannel(ctx, chID); err != nil {
		t.Fatalf("AdminDeleteChannel: %v", err)
	}

	var n int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM nsfw_acknowledgements WHERE channel_id = ?`, chID).Scan(&n); err != nil {
		t.Fatalf("count after delete: %v", err)
	}
	if n != 0 {
		t.Errorf("nsfw_acknowledgements after channel delete = %d, want 0 (cascade)", n)
	}
}

// TestNSFW_NewSessionInheritsTheAcknowledgement proves the row is keyed by
// (user_id, channel_id) alone, with no session or device in the key: a user
// who acknowledges on one session, logs out (their session is revoked) and
// signs in again on a brand-new session still reads as acknowledged — the
// whole point of a server-side row over the old client-only sessionStorage
// gate.
func TestNSFW_NewSessionInheritsTheAcknowledgement(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "multi-device")
	chID := nsfwChannel(t, database, "labelled")

	if _, err := database.CreateSession(ctx, uid, "hash-first-device", "phone", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession(first): %v", err)
	}
	if err := database.AcknowledgeNSFW(ctx, uid, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}

	// "Logout": the first session goes away entirely.
	if err := database.DeleteSession(ctx, "hash-first-device"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	// "Log in again": a brand-new session for the same user, no relation to
	// the first one.
	if _, err := database.CreateSession(ctx, uid, "hash-second-device", "phone", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession(second): %v", err)
	}

	if ok, err := database.HasNSFWAcknowledgement(ctx, uid, chID); err != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement after new session = (%v, %v), want (true, nil)", ok, err)
	}
}

// TestAdminUpdateChannelClearingNSFW_ClearsAcksInTheSameCommit proves the
// label-lifecycle rule: unlabelling a channel deletes its acknowledgement
// rows, and the flag write itself still lands.
func TestAdminUpdateChannelClearingNSFW_ClearsAcksInTheSameCommit(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	chID := nsfwChannel(t, database, "was-labelled")
	alice := seedUser(t, database, "alice")
	if err := database.AcknowledgeNSFW(ctx, alice, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}

	if err := database.AdminUpdateChannelClearingNSFW(ctx, chID, db.ChannelUpdate{
		Name: "was-labelled", NSFW: false,
	}); err != nil {
		t.Fatalf("AdminUpdateChannelClearingNSFW: %v", err)
	}

	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch.NSFW {
		t.Errorf("channel still labelled nsfw after the clearing update")
	}
	if ok, err := database.HasNSFWAcknowledgement(ctx, alice, chID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after clearing update = (%v, %v), want (false, nil)", ok, err)
	}
}
