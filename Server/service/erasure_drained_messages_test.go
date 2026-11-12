package service

import (
	"context"
	"testing"
)

// The messages the drain deleted reach the hub's replay purge, so edit frames
// still in the ring come out with them.
func TestErasureService_PurgesReplayForDrainedMessages(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(ctx, t, database, dir)
	var msgID int64
	mustDo(t, "message id", database.QueryRowContext(ctx, `SELECT id FROM messages WHERE user_id = ?`, uid).Scan(&msgID))
	hub := &recordingErasureHub{}
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetHub(hub)

	mustDo(t, "Erase", svc.Erase(ctx, uid))
	if len(hub.messageIDs) != 1 || hub.messageIDs[0] != msgID {
		t.Errorf("replay purge for messages %v, want [%d]", hub.messageIDs, msgID)
	}
	if len(svc.drained) != 0 {
		t.Errorf("drained ids kept after the purge: %v", svc.drained)
	}
}
