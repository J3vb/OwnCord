package ws

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// joinNoteRecorder wraps the hub's voice store and records the call log notes
// the join path posts.
type joinNoteRecorder struct {
	VoiceStore
	mu    sync.Mutex
	notes [][2]int64
}

func (r *joinNoteRecorder) NoteJoinCompleted(channelID, userID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notes = append(r.notes, [2]int64{channelID, userID})
	r.VoiceStore.NoteJoinCompleted(channelID, userID)
}

func (r *joinNoteRecorder) recorded() [][2]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][2]int64(nil), r.notes...)
}

func newJoinNoteHub(t *testing.T, name string) (*Hub, *joinNoteRecorder, *Client, int64, chan []byte) {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, name)
	chID := mustCreateVoiceChannel(t, database, name+"-vc")
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: healthyTestLiveKit(t)})
	rec := &joinNoteRecorder{VoiceStore: h.voice}
	h.voice = rec
	send := make(chan []byte, 32)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: name}
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()
	return h, rec, c, chID, send
}

// A completed join posts exactly one note, for that user and channel.
func TestVoiceJoin_NotesJoinOnCompletion(t *testing.T) {
	h, rec, c, chID, send := newJoinNoteHub(t, "note-join-ok")
	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")
	drainChan(send, 200*time.Millisecond)

	if got := c.voice.channel(); got != chID {
		t.Fatalf("join did not complete: voiceChID = %d, want %d", got, chID)
	}
	notes := rec.recorded()
	if len(notes) != 1 || notes[0] != [2]int64{chID, c.userID} {
		t.Errorf("notes = %v, want one for channel %d user %d", notes, chID, c.userID)
	}
}

// A join that rolls back after the row was written never posts a note, so the
// user is never a participant of a call they did not get into.
func TestVoiceJoin_NotesJoinOnlyOnCompletion(t *testing.T) {
	h, rec, c, chID, send := newJoinNoteHub(t, "note-join-rollback")
	database := h.db
	voiceJoinPostTokenRaceHook = func(*Client) {
		if _, err := database.ExecContext(context.Background(), `ALTER TABLE users RENAME TO users_bak_note`); err != nil {
			t.Errorf("hook: rename users: %v", err)
		}
	}
	defer func() { voiceJoinPostTokenRaceHook = nil }()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")
	drainChan(send, 200*time.Millisecond)

	if got := c.voice.channel(); got != 0 {
		t.Fatalf("join was expected to roll back, voiceChID = %d", got)
	}
	if notes := rec.recorded(); len(notes) != 0 {
		t.Errorf("a rolled-back join posted notes: %v", notes)
	}
}
