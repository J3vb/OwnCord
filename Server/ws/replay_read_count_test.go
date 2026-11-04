package ws

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// countingVisibilityReader counts the reads a reconnect replay makes through
// the visibility seam. Every call passes through to the real reader.
type countingVisibilityReader struct {
	VisibilityReader
	getChannel, hasAck, listAcked, gate atomic.Int64
}

func (r *countingVisibilityReader) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	r.getChannel.Add(1)
	return r.VisibilityReader.GetChannel(ctx, id)
}

func (r *countingVisibilityReader) HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error) {
	r.hasAck.Add(1)
	return r.VisibilityReader.HasNSFWAcknowledgement(ctx, userID, channelID)
}

func (r *countingVisibilityReader) ListNSFWAcknowledgedChannelIDs(ctx context.Context, userID int64) (map[int64]bool, error) {
	r.listAcked.Add(1)
	return r.VisibilityReader.ListNSFWAcknowledgedChannelIDs(ctx, userID)
}

func (r *countingVisibilityReader) ChannelContentGate(ctx context.Context, userID, channelID int64) (found, readable bool, err error) {
	r.gate.Add(1)
	return r.VisibilityReader.ChannelContentGate(ctx, userID, channelID)
}

// A 200-frame replay over three channels, two of them labelled (one
// acknowledged), costs one light gate read per content frame, never a full
// channel row, and one acknowledgement read for the whole handshake. The
// unacknowledged labelled channel's frames stay out of the replay.
func TestReconnectReplay_ReadsPerHandshake(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "replay-count-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	var chans [3]int64
	for i, name := range []string{"plain", "labelled-acked", "labelled-unacked"} {
		if chans[i], err = database.CreateChannel(ctx, name, "text", "", "", 0); err != nil {
			t.Fatalf("CreateChannel(%s): %v", name, err)
		}
	}
	for _, id := range chans[1:] {
		if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, id); err != nil {
			t.Fatalf("label channel: %v", err)
		}
	}
	if _, err := database.AcknowledgeNSFW(ctx, userID, chans[1]); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	reader := &countingVisibilityReader{VisibilityReader: database}
	hub := newTestHubWith(t, HubOptions{
		DB:      database,
		Limiter: auth.NewRateLimiter(),
		Readers: HubReaders{Visibility: reader, Ready: database, Members: database, Dispatch: database},
	})
	go hub.Run()
	t.Cleanup(hub.Stop)
	waitUntilRunning(t, hub)

	const frames = 200
	rb := hub.ReplayBuffer()
	// The ring trusts a resume only when last_seq is newer than its oldest entry,
	// so two anchors sit below the replayed range.
	for seq := int64(1); seq <= 2; seq++ {
		rb.Push(uint64(seq), chans[0], []byte(`{"seq":`+itoaTest(seq)+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(chans[0])+`,"content":"anchor"}}`))
	}
	wantDelivered := 0
	for i := range frames {
		seq := int64(i + 3)
		ch := chans[i%3]
		if i%3 != 2 {
			wantDelivered++
		}
		rb.Push(uint64(seq), ch, []byte(`{"seq":`+itoaTest(seq)+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(ch)+`,"content":"replay-frame"}}`))
	}

	events := dialAndResume(t, hub, token, 2)
	delivered := 0
	for _, evt := range events {
		if strings.Contains(string(evt), "replay-frame") {
			delivered++
		}
	}
	if delivered != wantDelivered {
		t.Fatalf("replayed %d content frames, want %d (the unacknowledged labelled channel's frames withheld)", delivered, wantDelivered)
	}
	if got := reader.gate.Load(); got != int64(wantDelivered) {
		t.Errorf("per-frame gate reads = %d, want %d (one per replayed content frame)", got, wantDelivered)
	}
	if got := reader.getChannel.Load(); got != 0 {
		t.Errorf("GetChannel reads = %d, want 0: the replay must not load full channel rows per frame", got)
	}
	if got := reader.hasAck.Load(); got != 0 {
		t.Errorf("HasNSFWAcknowledgement reads = %d, want 0: acknowledgements come from one list read", got)
	}
	if got := reader.listAcked.Load(); got != 1 {
		t.Errorf("acknowledgement list reads = %d, want 1 per handshake", got)
	}
}
