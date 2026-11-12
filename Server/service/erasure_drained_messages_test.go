package service

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// The replay purge step needs nothing from the drain: a service with no memory of it
// (a restart between the drain and the purge) still removes an edit frame written for
// an erased message after the drain, and leaves another user's.
func TestErasureService_PurgeReplayAfterRestartRemovesLateEditFrames(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(ctx, t, database, dir)
	var msgID, chID int64
	mustDo(t, "message", database.QueryRowContext(ctx, `SELECT id, channel_id FROM messages WHERE user_id = ?`, uid).Scan(&msgID, &chID))
	other, err := database.CreateUser(ctx, "erasure-bystander", "hash", 4)
	mustDo(t, "CreateUser", err)
	otherMsg, err := database.CreateMessage(ctx, chID, other, "keep", nil)
	mustDo(t, "CreateMessage", err)

	job, err := database.EraseAccountLock(ctx, uid, true)
	mustDo(t, "lock", err)
	done, err := database.EraseAccountDrain(ctx, uid, time.Time{})
	if err != nil || !done {
		t.Fatalf("drain = %v, %v", done, err)
	}
	_, err = database.EraseAccountFinish(ctx, uid, "")
	mustDo(t, "finish", err)
	for i, id := range []int64{msgID, otherMsg} {
		_, err := database.ExecContext(ctx, `INSERT INTO events (seq, event_type, payload, channel_id) VALUES (?, 'chat_edited', ?, ?)`,
			9000+i, fmt.Sprintf(`{"seq":%d,"type":"chat_edited","payload":{"id":%d,"content":"late"}}`, 9000+i, id), chID)
		mustDo(t, "late event", err)
	}

	restarted := NewErasureService(database)
	mustDo(t, "purgeReplay", restarted.purgeReplay(ctx, uid, job.ID))
	var left int
	mustDo(t, "count", database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE seq >= 9000`).Scan(&left))
	if left != 1 {
		t.Errorf("late events left = %d, want only the bystander's", left)
	}
	hub := &recordingErasureHub{}
	restarted.SetHub(hub)
	mustDo(t, "purgeReplay with hub", restarted.purgeReplay(ctx, uid, job.ID))
	if len(hub.messagePurges) != 1 || hub.messagePurges[0] != job.ID {
		t.Errorf("hub message purges = %v, want one for job %d", hub.messagePurges, job.ID)
	}
}
