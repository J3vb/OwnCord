package db_test

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestInsertWelcomeRow_WritesKind8AndAdvancesReadState(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	ch, err := database.CreateChannel(ctx, "lobby", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	row, err := database.InsertWelcomeRow(ctx, ch, alice, "alice joined the server.")
	if err != nil {
		t.Fatalf("InsertWelcomeRow: %v", err)
	}
	var kind int64
	if err := database.QueryRowContext(ctx, `SELECT kind FROM messages WHERE id = ?`, row.MessageID).Scan(&kind); err != nil || kind != db.MessageKindMemberJoin {
		t.Fatalf("kind = %d err=%v, want %d", kind, err, db.MessageKindMemberJoin)
	}
	var last int64
	if err := database.QueryRowContext(ctx, `SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?`, alice, ch).Scan(&last); err != nil || last != row.MessageID {
		t.Fatalf("read state = %d err=%v, want %d", last, err, row.MessageID)
	}
	msgs, err := database.GetMessagesForAPI(ctx, ch, 0, 10, alice)
	if err != nil || len(msgs) != 1 || msgs[0].Kind != "member_join" || msgs[0].User.ID != alice {
		t.Fatalf("history = %+v err=%v, want one member_join row by alice", msgs, err)
	}
	// A channel purge takes the row with the rest.
	ids, err := database.PurgeChannelMessages(ctx, ch, 0, 10)
	if err != nil || len(ids) != 1 || ids[0] != row.MessageID {
		t.Fatalf("purge = %v err=%v, want the welcome row", ids, err)
	}
}

func TestGetReferencedMessages_WelcomeRowIsRepliable(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	ch, _ := database.CreateChannel(ctx, "lobby", "text", "", "", 0)
	row, err := database.InsertWelcomeRow(ctx, ch, alice, "alice joined the server.")
	if err != nil {
		t.Fatal(err)
	}
	refs, err := database.GetReferencedMessages(ctx, ch, []int64{row.MessageID})
	if err != nil || refs[row.MessageID] == nil || refs[row.MessageID].IsSystem {
		t.Fatalf("welcome ref = %+v err=%v, want a repliable (not IsSystem) target", refs[row.MessageID], err)
	}
}

// welcome.sql is exempt from TestCallLog_OnlyWriterOfKind, so it must hold
// only the kind-8 insert: a later query there cannot create or retype rows.
func TestWelcomeSQL_HoldsOnlyTheKind8Insert(t *testing.T) {
	raw, err := os.ReadFile("queries/sqlite/welcome.sql")
	if err != nil {
		t.Fatalf("read welcome.sql: %v", err)
	}
	src := string(raw)
	if n := strings.Count(src, "-- name:"); n != 1 {
		t.Fatalf("welcome.sql holds %d queries, want 1", n)
	}
	if !strings.Contains(src, "-- name: InsertWelcomeMessage :one") ||
		!regexp.MustCompile(`(?is)INSERT\s+INTO\s+messages\s*\([^)]*\bkind\)\s*VALUES\s*\([^)]*,\s*8\)`).MatchString(src) {
		t.Errorf("welcome.sql must hold only the kind-8 InsertWelcomeMessage insert:\n%s", src)
	}
	if regexp.MustCompile(`(?i)\bUPDATE\s+messages\b`).MatchString(src) {
		t.Errorf("welcome.sql must not update messages:\n%s", src)
	}
}
