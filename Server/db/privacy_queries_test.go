package db_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestUserPrivacy_DefaultsWithoutRow(t *testing.T) {
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "no-privacy-row")

	got, err := database.GetUserPrivacy(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserPrivacy: %v", err)
	}
	if want := (db.UserPrivacy{AllowMemberDMs: true, MessageRequests: true}); got != want {
		t.Errorf("privacy = %+v, want %+v", got, want)
	}
	if n := scalarInt(t, database, `SELECT COUNT(*) FROM user_privacy`); n != 0 {
		t.Errorf("reading wrote %d rows, want 0", n)
	}
}

func TestUserPrivacy_UpsertRoundTripAndReplacesWholeRow(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "privacy-owner")
	other := seedUser(t, database, "privacy-other")

	first := db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}
	if err := database.SetUserPrivacy(ctx, uid, first); err != nil {
		t.Fatalf("SetUserPrivacy: %v", err)
	}
	if got, err := database.GetUserPrivacy(ctx, uid); err != nil || got != first {
		t.Fatalf("round trip = %+v, %v; want %+v", got, err, first)
	}

	second := db.UserPrivacy{AllowMemberDMs: true, MessageRequests: false}
	if err := database.SetUserPrivacy(ctx, uid, second); err != nil {
		t.Fatalf("second SetUserPrivacy: %v", err)
	}
	if got, err := database.GetUserPrivacy(ctx, uid); err != nil || got != second {
		t.Fatalf("after second upsert = %+v, %v; want %+v (whole row replaced)", got, err, second)
	}
	if n := scalarInt(t, database, `SELECT COUNT(*) FROM user_privacy WHERE user_id = ?`, uid); n != 1 {
		t.Errorf("rows for owner = %d, want 1", n)
	}
	if got, err := database.GetUserPrivacy(ctx, other); err != nil || got != db.DefaultUserPrivacy() {
		t.Errorf("another user's privacy = %+v, %v; want defaults", got, err)
	}
}

func TestUserPrivacy_NotInMemberPayloads(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "payload-user")
	if err := database.SetUserPrivacy(ctx, uid, db.UserPrivacy{}); err != nil {
		t.Fatalf("SetUserPrivacy: %v", err)
	}
	members, err := database.ListMembers(ctx)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	for name, v := range map[string]any{"members": members, "user": user} {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		for _, key := range []string{"allow_member_dms", "message_requests", "AllowMemberDMs", "MessageRequests"} {
			if strings.Contains(string(raw), key) {
				t.Errorf("%s payload carries %q", name, key)
			}
		}
	}
}

func TestUserPrivacy_CheckConstraintRejectsOutOfRange(t *testing.T) {
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "check-user")
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO user_privacy (user_id, allow_member_dms) VALUES (?, 2)`, uid)
	if err == nil {
		t.Error("allow_member_dms = 2 was accepted")
	}
}
