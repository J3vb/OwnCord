package ws_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// The ring buffer's check and the events table's predicate are one rule over
// two stores: they must agree on every frame, including a call log row, which
// names its participants under call.participants, and a group add or remove
// row, which names its target under group_event.target_user_id.
func TestEventNamesUser_RingAndSQLPredicateAgree(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	ctx := context.Background()
	const uid, other = 42, 43
	frames := []struct {
		name    string
		payload string
		names   bool
	}{
		{"call start names a participant", fmt.Sprintf(`{"seq":1,"type":"chat_message","payload":{"id":5,"user":{"id":%d},"kind":"call","call":{"started_at":"s","ended_at":null,"participants":[%d,%d]}}}`, other, other, uid), true},
		{"call end names a participant", fmt.Sprintf(`{"seq":2,"type":"chat_edited","payload":{"message_id":5,"kind":"call","edited_at":null,"call":{"started_at":"s","ended_at":"e","participants":[%d]}}}`, uid), true},
		{"call without the user", fmt.Sprintf(`{"seq":3,"type":"chat_message","payload":{"id":6,"user":{"id":%d},"kind":"call","call":{"started_at":"s","ended_at":null,"participants":[%d]}}}`, other, other), false},
		{"call author is the user", fmt.Sprintf(`{"seq":4,"type":"chat_message","payload":{"id":7,"user":{"id":%d},"kind":"call","call":{"participants":[]}}}`, uid), true},
		{"group add names its target", fmt.Sprintf(`{"seq":7,"type":"chat_message","payload":{"id":8,"user":{"id":%d},"kind":"group_add","group_event":{"target_user_id":%d}}}`, other, uid), true},
		{"group add names another target", fmt.Sprintf(`{"seq":8,"type":"chat_message","payload":{"id":9,"user":{"id":%d},"kind":"group_add","group_event":{"target_user_id":%d}}}`, other, other), false},
		{"group leave has no target", fmt.Sprintf(`{"seq":9,"type":"chat_message","payload":{"id":10,"user":{"id":%d},"kind":"group_leave","group_event":{}}}`, other), false},
		{"empty participants", `{"seq":5,"type":"chat_edited","payload":{"message_id":5,"call":{"participants":[]}}}`, false},
		{"no call block", `{"seq":6,"type":"chat_edited","payload":{"message_id":5,"call":null}}`, false},
	}
	for i, f := range frames {
		if _, err := database.ExecContext(ctx, `INSERT INTO events (seq, event_type, payload, channel_id) VALUES (?, 'x', ?, 0)`, i+1, f.payload); err != nil {
			t.Fatalf("seed %q: %v", f.name, err)
		}
		var sqlHit int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE seq = ?2 AND `+db.EventNamesUserPredicate, uid, i+1).Scan(&sqlHit); err != nil {
			t.Fatalf("predicate %q: %v", f.name, err)
		}
		ringHit := ws.EventNamesUserForTest([]byte(f.payload), uid)
		if (sqlHit == 1) != f.names || ringHit != f.names {
			t.Errorf("%s: sql=%v ring=%v, want %v", f.name, sqlHit == 1, ringHit, f.names)
		}
	}
}
