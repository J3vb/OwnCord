package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// cancelAfterArm is a context.Context whose Done()/Err() behave as
// "never cancelled" until Cancel() is called, at which point they behave as
// an ordinary cancelled context from then on. It simulates a request context
// that gets cancelled *partway through* handling a request (e.g. the client
// disconnecting right after a DB commit), deterministically rather than via
// a wall-clock race.
type cancelAfterArm struct {
	context.Context
	armed atomic.Bool
	done  chan struct{}
}

func newCancelAfterArm(parent context.Context) *cancelAfterArm {
	return &cancelAfterArm{Context: parent, done: make(chan struct{})}
}

func (c *cancelAfterArm) Cancel() {
	if c.armed.CompareAndSwap(false, true) {
		close(c.done)
	}
}

func (c *cancelAfterArm) Done() <-chan struct{} {
	if c.armed.Load() {
		return c.done
	}
	return nil
}

func (c *cancelAfterArm) Err() error {
	if c.armed.Load() {
		return context.Canceled
	}
	return nil
}

// cancelOnLookupStore wraps the real *db.DB. Its GetDMParticipantIDs cancels
// reqCtx — standing in for the client hanging up immediately after the
// rename's DB commit, i.e. right when the handler goes to look up
// participants for the fan-out — and then performs the real lookup with
// whatever ctx it was handed. If the caller passed r.Context() straight
// through, the lookup itself observes the cancellation and fails; if the
// caller detached it first (context.WithoutCancel), the lookup is unaffected
// and succeeds. This is exactly OC-0222's repro.
//
// Because reqCtx is also the *http.Request's own context, every later
// r.Context()-based call in the handler (e.g. the final DMSummaryFor) is
// realistically affected too — matching a real dropped connection, where
// everything downstream of the disconnect point shares the same fate. Only
// the fan-out (broadcastDMOpen / MarkVisibilityChanged) is this finding's
// concern; the eventual HTTP response is moot once the client is gone, so
// the test does not assert on it.
type cancelOnLookupStore struct {
	*db.DB
	reqCtx *cancelAfterArm
}

func (s *cancelOnLookupStore) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	s.reqCtx.Cancel()
	return s.DB.GetDMParticipantIDs(ctx, channelID)
}

// OC-0222: handleRenameGroupDM's post-rename fan-out — the per-viewer
// dm_channel_open refresh *and* the visibility-watermark bump nested inside
// broadcastDMOpen — is gated on a participant lookup that (before the fix)
// runs on the still-cancellable r.Context(). The rename has already
// committed by then, so if the request context is cancelled in the gap
// (client disconnects right after the write), the lookup fails and the
// entire fan-out is silently skipped: survivors keep rendering the stale
// name, and since dm_channel_open is unsequenced/targeted, only a full
// resync — never a warm reconnect's seq replay — would repair it.
func TestRenameGroupDM_FanOutSurvivesContextCancelledAfterCommit(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}

	// Build the group DM up front over an ordinary router/context so fixture
	// setup is unaffected by the special context used for the rename request
	// itself.
	setupRouter := chi.NewRouter()
	setupSvc := service.New(database, auth.NewRateLimiter())
	api.MountDMRoutes(setupRouter, database, setupSvc, bc)
	tokens := []string{
		dmCreateToken(t, database, "rn_alice", 4),
		dmCreateToken(t, database, "rn_bob", 4),
		dmCreateToken(t, database, "rn_carol", 4),
	}
	group := decodeDMInfo(t, dmPost(t, setupRouter, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.sent = nil
	bc.markCalls = 0

	// Now build a router whose ChannelService cancels the *request's own*
	// context the instant the post-rename participant lookup runs.
	reqCtx := newCancelAfterArm(context.Background())
	renameRouter := chi.NewRouter()
	renameSvc := service.New(database, auth.NewRateLimiter())
	renameSvc.Channels = service.NewChannelService(&cancelOnLookupStore{DB: database, reqCtx: reqCtx}, renameSvc.Permissions)
	api.MountDMRoutes(renameRouter, database, renameSvc, bc)

	body, _ := json.Marshal(map[string]any{"name": "Renamed after disconnect"})
	req := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokens[1])
	req.RemoteAddr = "127.0.0.1:9999"
	req = req.WithContext(reqCtx)
	rr := httptest.NewRecorder()
	renameRouter.ServeHTTP(rr, req)

	if !reqCtx.armed.Load() {
		t.Fatal("test bug: the request context was never armed/cancelled — this run does not exercise the repro")
	}

	// The rename mutation itself must have committed — the finding is
	// explicitly about the fan-out after a successful commit, not about the
	// commit itself. Read it back independently of rr's (possibly errored,
	// and irrelevant once the "client" is gone) HTTP response.
	ch, err := database.GetChannel(context.Background(), group.ChannelID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel after rename: %v (ch=%v)", err, ch)
	}
	if ch.Name != "Renamed after disconnect" {
		t.Fatalf("expected the rename to have committed despite the later context cancellation, got name %q", ch.Name)
	}

	if len(bc.sent) != 3 {
		t.Errorf("expected all 3 participants notified of the rename despite the post-commit context cancellation, got %d sends", len(bc.sent))
	}
	if bc.markCalls < 1 {
		t.Errorf("MarkVisibilityChanged calls = %d, want at least 1: without it a warm reconnect after the dropped fan-out can never observe the rename via seq replay", bc.markCalls)
	}
}
