package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

func TestEventNamesUser_ThreadOwner(t *testing.T) {
	const uid, other = 42, 43
	cases := []struct {
		frame string
		want  bool
	}{
		{fmt.Sprintf(`{"seq":1,"type":"thread_changed","payload":{"thread":{"id":5,"owner_id":%d}}}`, uid), true},
		{fmt.Sprintf(`{"seq":2,"type":"thread_changed","payload":{"thread":{"id":5,"owner_id":%d}}}`, other), false},
		{`{"seq":3,"type":"thread_changed","payload":{"thread":{"id":5}}}`, false},
	}
	for _, c := range cases {
		if got := ws.EventNamesUserForTest([]byte(c.frame), uid); got != c.want {
			t.Errorf("EventNamesUser(%s) = %v, want %v", c.frame, got, c.want)
		}
	}
}

func editFramesFor(hub *ws.Hub, msgID int64) int {
	n := 0
	for _, frame := range hub.ReplayBuffer().AllFramesForTest() {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID        int64 `json:"id"`
				MessageID int64 `json:"message_id"`
			} `json:"payload"`
		}
		if json.Unmarshal(frame, &env) == nil && env.Type == "chat_edited" && (env.Payload.ID == msgID || env.Payload.MessageID == msgID) {
			n++
		}
	}
	return n
}

func firstMessageOf(t *testing.T, database *db.DB, uid int64) int64 {
	t.Helper()
	var id int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM messages WHERE user_id = ? LIMIT 1`, uid).Scan(&id); err != nil {
		t.Fatalf("message of %d: %v", uid, err)
	}
	return id
}

// An edit frame names its message and not its author; erasing the author must still
// take it out of the ring and the stored events, and leave another user's edit.
func TestErasure_PurgesEditFramesOfErasedMessages(t *testing.T) {
	hub, database, svc, persister, ctx := newReplayPipeline(t)
	svc.Erasure.SetHub(hub)

	if _, err := database.CreateUser(ctx, "edit-other-owner", "hash", 1); err != nil {
		t.Fatal(err)
	}
	subject := seedCoverageOwner(t, database, "edit-subject")
	observer := seedCoverageOwner(t, database, "edit-observer")
	chID := seedTestChannel(t, database, "edit-chan")
	sc, _ := connectClient(t, hub, subject, chID, 64)
	oc, _ := connectClient(t, hub, observer, chID, 64)

	hub.HandleMessageForTest(sc, envelope("chat_send", map[string]any{"channel_id": chID, "content": "mine"}))
	hub.HandleMessageForTest(oc, envelope("chat_send", map[string]any{"channel_id": chID, "content": "theirs"}))
	waitFor(t, waitTimeout, func() bool {
		return firstMessageOf(t, database, subject.ID) > 0 && firstMessageOf(t, database, observer.ID) > 0
	}, "both messages to be stored")
	subjectMsg, observerMsg := firstMessageOf(t, database, subject.ID), firstMessageOf(t, database, observer.ID)
	hub.HandleMessageForTest(sc, envelope("chat_edit", map[string]any{"message_id": subjectMsg, "content": "mine, edited"}))
	hub.HandleMessageForTest(oc, envelope("chat_edit", map[string]any{"message_id": observerMsg, "content": "theirs, edited"}))
	waitFor(t, waitTimeout, func() bool { return editFramesFor(hub, subjectMsg) > 0 && editFramesFor(hub, observerMsg) > 0 },
		"both edit frames to reach the ring buffer")

	if err := persister.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	storedEdits := func(msgID int64) int {
		var n int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE event_type = 'chat_edited' AND (json_extract(payload, '$.payload.id') = ?1 OR json_extract(payload, '$.payload.message_id') = ?1)`, msgID).Scan(&n); err != nil {
			t.Fatalf("count stored edits: %v", err)
		}
		return n
	}
	if n := storedEdits(subjectMsg); n != 1 {
		t.Fatalf("stored edits for the erased user's message before the erasure = %d, want 1 (positive control)", n)
	}

	if err := svc.Erasure.Erase(ctx, subject.ID); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	if n := editFramesFor(hub, subjectMsg); n != 0 {
		t.Errorf("ring still holds %d edit frames for the erased user's message", n)
	}
	if n := storedEdits(subjectMsg); n != 0 {
		t.Errorf("stored edit events for the erased user's message = %d, want 0", n)
	}
	// A frame for the erased message that reaches the table after the erasure (a queue
	// flushed late) goes when the replay purge runs again, with no state from the first run.
	var jobID int64
	if err := database.QueryRowContext(ctx, `SELECT id FROM erasure_jobs WHERE user_id = ?`, subject.ID).Scan(&jobID); err != nil {
		t.Fatalf("job id: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO events (seq, event_type, payload, channel_id) VALUES (999999, 'chat_edited', ?, ?)`,
		fmt.Sprintf(`{"seq":999999,"type":"chat_edited","payload":{"id":%d,"content":"late"}}`, subjectMsg), chID); err != nil {
		t.Fatalf("late event: %v", err)
	}
	if err := hub.PurgeErasedMessagesFromReplay(ctx, jobID); err != nil {
		t.Fatalf("PurgeErasedMessagesFromReplay: %v", err)
	}
	if n := storedEdits(subjectMsg); n != 0 {
		t.Errorf("late stored edit for the erased message = %d after the purge, want 0", n)
	}
	if n := editFramesFor(hub, observerMsg); n != 1 {
		t.Errorf("ring edit frames for the other user's message = %d, want 1", n)
	}
}
