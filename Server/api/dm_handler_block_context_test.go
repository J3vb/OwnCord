package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// cancelAfterBlockStore wraps a real in-memory *db.DB and cancels an
// externally supplied context the instant BlockUser's write commits,
// simulating a client disconnect landing between the block commit and the
// post-commit voice-eviction gate (OC-0198). FindDMChannelIDBetween is
// overridden to fail fast on an already-canceled context, mirroring the
// context.Canceled a real sql query would surface in that window.
type cancelAfterBlockStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (s *cancelAfterBlockStore) BlockUser(ctx context.Context, blockerID, blockedID int64) error {
	err := s.DB.BlockUser(ctx, blockerID, blockedID)
	if err == nil {
		s.cancel()
	}
	return err
}

func (s *cancelAfterBlockStore) FindDMChannelIDBetween(ctx context.Context, user1ID, user2ID int64) (int64, bool, error) {
	if err := ctx.Err(); err != nil {
		return 0, false, err
	}
	return s.DB.FindDMChannelIDBetween(ctx, user1ID, user2ID)
}

// TestBlockUser_EvictsVoiceEvenIfRequestContextCanceledAfterCommit pins
// OC-0198: BlockUser has already committed once the store call returns, so a
// client disconnect that cancels the request context right after must not
// suppress the post-commit voice eviction. The shared-DM lookup gating that
// eviction has to run on a context detached from the request — the same way
// the eviction call itself already does — or the blocked user stays in the
// blocker's live 1:1 DM call forever.
func TestBlockUser_EvictsVoiceEvenIfRequestContextCanceledAfterCommit(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}

	alice := dmCreateToken(t, database, "alice", 4)
	dmCreateToken(t, database, "bob", 4)

	setupRouter := buildDMRouter(database, bc)
	rr := dmPost(t, setupRouter, "/api/v1/dms", alice, map[string]any{"recipient_id": 2})
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create-dm response %q: %v", rr.Body.String(), err)
	}
	bc.evictCalls = nil

	ctx, cancel := context.WithCancel(context.Background())
	store := &cancelAfterBlockStore{DB: database, cancel: cancel}
	svc := service.New(store, auth.NewRateLimiter())

	r := chi.NewRouter()
	api.MountDMRoutes(r, database, svc, bc)

	req := httptest.NewRequest(http.MethodPut, "/api/v1/blocks/2", nil)
	req.Header.Set("Authorization", "Bearer "+alice)
	req.RemoteAddr = "127.0.0.1:9999"
	req = req.WithContext(ctx)
	blockRR := httptest.NewRecorder()
	r.ServeHTTP(blockRR, req)

	if blockRR.Code != http.StatusOK {
		t.Fatalf("block: %d %s", blockRR.Code, blockRR.Body.String())
	}
	if len(bc.evictCalls) != 1 || bc.evictCalls[0].userID != 2 || bc.evictCalls[0].channelID != created.ChannelID {
		t.Fatalf("DisconnectFromVoiceInChannel calls = %+v, want exactly one for user=2 channel=%d even though "+
			"the request context was canceled right after the block commit", bc.evictCalls, created.ChannelID)
	}
}
