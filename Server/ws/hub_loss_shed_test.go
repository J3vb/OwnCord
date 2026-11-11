package ws

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func holdTopicWindowOpen(t *testing.T) {
	t.Helper()
	saved := topicRateWindow.Load()
	topicRateWindow.Store(int64(time.Hour))
	t.Cleanup(func() { topicRateWindow.Store(saved) })
}

// deliverContentFrames runs n content frames (contentFrame: channel-scoped with
// nsfwChannelID set, as broadcastChannelEvent enqueues them) through the gated
// delivery the dispatch loop uses for a hub without a database (an empty gate
// result).
func deliverContentFrames(h *Hub, channelID int64, n int) {
	for range n {
		h.deliverGated(contentFrame(channelID, "x"), gateResult{})
	}
}

// A content frame the topic limiter sheds consumed no seq, so replay cannot
// carry it: a subscriber that stays connected must see a cseq gap, and a resume
// at or behind it must take the full ready. A subscriber of another channel is
// left alone.
func TestTopicShed_ContentFrameMarksSubscribersAndBumpsWatermark(t *testing.T) {
	holdTopicWindowOpen(t)
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 6)

	deliverContentFrames(h, 5, topicRateLimitPerSecond)
	if lossMarked(h, 1) || h.visibilityChangeSeq.Load() != 0 {
		t.Fatal("loss was marked before any frame was shed")
	}

	deliverContentFrames(h, 5, 1)

	if got := h.TopicShedCount(); got != 1 {
		t.Fatalf("TopicShedCount = %d, want 1", got)
	}
	if !lossMarked(h, 1) {
		t.Fatal("a subscriber of the shed channel was not marked for resync")
	}
	if h.presenceResyncPending(2, "") || h.clients[2][0].cseq.lossPending.Load() {
		t.Fatal("a subscriber of another channel was marked")
	}
	if h.visibilityChangeSeq.Load() == 0 || h.visibilityChangeSeq.Load() != h.seq {
		t.Fatalf("watermark = %d, want the current seq %d", h.visibilityChangeSeq.Load(), h.seq)
	}
	h.seqMu.Lock()
	full := h.mustFullResyncAtRegister(1, 99, "x")
	h.seqMu.Unlock()
	if !full {
		t.Fatal("a resume from before the shed must take the full ready")
	}
}

// A metadata shed stays a drop: no watermark, no mark. The limiter key is the
// same for both kinds, so the metadata frame is shed on the first frame past
// the budget.
func TestTopicShed_MetadataFrameMarksNobody(t *testing.T) {
	holdTopicWindowOpen(t)
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)

	frame := []byte(`{"type":"chat_deleted","payload":{"id":1,"channel_id":5}}`)
	for range topicRateLimitPerSecond + 1 {
		h.BroadcastToChannel(5, frame)
		drainQueueThroughDispatch(h)
	}
	if got := h.TopicShedCount(); got != 1 {
		t.Fatalf("TopicShedCount = %d, want 1", got)
	}
	if lossMarked(h, 1) || h.presenceResyncPending(1, "") || h.clients[1][0].cseq.lossPending.Load() {
		t.Fatal("a metadata shed marked a subscriber")
	}
	if got := h.LossMarkCount(); got != 0 {
		t.Fatalf("LossMarkCount = %d, want 0", got)
	}
	if h.visibilityChangeSeq.Load() != 0 {
		t.Fatal("a metadata shed moved the watermark")
	}
}

// A content shed on a channel nobody subscribes to has nobody to mark.
func TestTopicShed_NoSubscribersMarksNobody(t *testing.T) {
	holdTopicWindowOpen(t)
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 6)

	deliverContentFrames(h, 5, topicRateLimitPerSecond+1)
	if got := h.TopicShedCount(); got != 1 {
		t.Fatalf("TopicShedCount = %d, want 1", got)
	}
	if lossMarked(h, 1) || h.presenceResyncPending(1, "") {
		t.Fatal("a client outside the shed channel was marked")
	}
	if got := h.LossMarkCount(); got != 0 {
		t.Fatalf("LossMarkCount = %d, want 0", got)
	}
}

type audienceFailingReader struct {
	DispatchReader
	failFor int64
}

func (r audienceFailingReader) GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error) {
	if userID == r.failFor {
		return nil, errors.New("role lookup down")
	}
	return r.DispatchReader.GetMemberRoles(ctx, userID)
}

// A user whose permission lookup fails is left out of a recipient-addressed
// frame; replay would skip them too, so they are marked and resync at the next
// dispatch. The other users still receive the frame.
func TestChannelReadAudience_UnresolvedUserIsMarkedForResync(t *testing.T) {
	ctx := context.Background()
	database := newTeardownTestDB(t)
	chID := mustCreateChannel(t, database, "aud-text", "text")
	var ids [3]int64
	for i, name := range []string{"aud-a", "aud-b", "aud-c"} {
		ids[i] = mustCreateUser(t, database, name, 4)
	}
	h := newTestHub(t, database, nil, nil)
	h.perms = nil // the bare-hub branch reads the Dispatch reader
	h.readers.Dispatch = audienceFailingReader{DispatchReader: h.readers.Dispatch, failFor: ids[2]}
	var sends [3]chan []byte
	for i, id := range ids {
		sends[i] = registerEmitTestClient(h, id, 0)
	}

	audience := h.channelReadAudience(ctx, chID)
	if len(audience) != 2 {
		t.Fatalf("audience = %v, want the two resolvable users", audience)
	}
	h.broadcastChannelScopedTo(chID, []byte(`{"type":"voice_state","payload":{"channel_id":1}}`), audience, 0, "voice")
	drainQueueThroughDispatch(h)
	h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	drainQueueThroughDispatch(h)

	for i := range 2 {
		if !chanHasFrame(sends[i], "voice_state") {
			t.Fatalf("user %d did not receive the voice_state frame", ids[i])
		}
		if lossMarked(h, ids[i]) {
			t.Fatalf("user %d was marked though it was resolved", ids[i])
		}
	}
	if !lossMarked(h, ids[2]) {
		t.Fatal("the user whose lookup failed was not marked for resync")
	}
}

func chanHasFrame(ch chan []byte, typ string) bool {
	for {
		select {
		case f := <-ch:
			if strings.Contains(string(f), typ) {
				return true
			}
		default:
			return false
		}
	}
}
