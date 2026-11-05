package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// thread_changed names its channel only as payload.thread.parent_id.
func TestPayloadChannelID_ThreadChangedUsesTheParent(t *testing.T) {
	frame := buildThreadChanged(&db.ThreadInfo{ID: 9, ParentID: 4, Name: "t"})
	if got := payloadChannelID(frame); got != 4 {
		t.Fatalf("payloadChannelID(thread_changed) = %d, want the parent 4", got)
	}
	if got := payloadChannelID(buildThreadDeleted(5, 9)); got != 5 {
		t.Fatalf("payloadChannelID(thread_deleted) = %d, want 5", got)
	}
	if got := payloadChannelID([]byte(`{"type":"x","payload":{}}`)); got != 0 {
		t.Fatalf("payloadChannelID(no channel) = %d, want 0", got)
	}
}

// A thread_changed missed while disconnected is replayed on resume, like any
// other frame of a readable parent, and withheld under a labelled parent the
// user has not acknowledged.
func TestReconnect_ReplaysThreadChanged(t *testing.T) {
	t.Parallel()
	t.Run("readable parent", func(t *testing.T) {
		if !resumeSeesThreadChanged(t, false) {
			t.Fatal("resume dropped a thread_changed for a readable parent")
		}
	})
	t.Run("unacknowledged labelled parent", func(t *testing.T) {
		if resumeSeesThreadChanged(t, true) {
			t.Fatal("resume replayed a thread_changed under an unacknowledged labelled parent")
		}
	})
}

func resumeSeesThreadChanged(t *testing.T, labelled bool) bool {
	t.Helper()
	database := newTeardownTestDB(t)

	userID := mustCreateUser(t, database, "resume-thread-user", 4)
	parent := mustCreateChannel(t, database, "resume-parent", "text")
	if labelled {
		mustExec(t, database, `UPDATE channels SET nsfw = 1 WHERE id = ?`, parent)
	}
	token := seedSessionToken(t, database, userID)

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)

	rb := hub.ReplayBuffer()
	rb.Push(98, parent, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(parent)+`,"content":"pre"}}`))
	rb.Push(99, parent, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(parent)+`,"content":"anchor"}}`))
	changed := buildThreadChanged(&db.ThreadInfo{ID: 77, ParentID: parent, Name: "RENAMED-WHILE-AWAY"})
	var stamped map[string]any
	if err := json.Unmarshal(changed, &stamped); err != nil {
		t.Fatalf("unmarshal thread_changed: %v", err)
	}
	stamped["seq"] = 100
	withSeq, _ := json.Marshal(stamped)
	rb.Push(100, parent, withSeq)

	for _, evt := range dialAndResume(t, hub, token, 99) {
		if strings.Contains(string(evt), "RENAMED-WHILE-AWAY") {
			return true
		}
	}
	return false
}
