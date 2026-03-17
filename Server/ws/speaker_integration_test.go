package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/ws"
)

// ─── VoiceRoom speaker detection ─────────────────────────────────────────────

func TestVoiceRoom_UpdateSpeakerLevel(t *testing.T) {
	cfg := ws.VoiceRoomConfig{
		ChannelID:   1,
		TopSpeakers: 3,
	}
	room := ws.NewVoiceRoom(cfg)

	// Add participants first.
	_ = room.AddParticipant(10)
	_ = room.AddParticipant(20)
	_ = room.AddParticipant(30)

	// User 10 is loudest (lowest dBov = 10), user 30 quietest (90).
	for range 5 {
		room.UpdateSpeakerLevel(10, 10)
		room.UpdateSpeakerLevel(20, 50)
		room.UpdateSpeakerLevel(30, 90)
	}

	top := room.TopSpeakers()
	if len(top) == 0 {
		t.Fatal("TopSpeakers returned empty; expected at least one active speaker")
	}
	if top[0] != int64(10) {
		t.Errorf("top speaker = %d, want 10 (loudest)", top[0])
	}
}

func TestVoiceRoom_TopSpeakers_EmptyRoom(t *testing.T) {
	cfg := ws.VoiceRoomConfig{
		ChannelID:   2,
		TopSpeakers: 3,
	}
	room := ws.NewVoiceRoom(cfg)

	top := room.TopSpeakers()
	if len(top) != 0 {
		t.Errorf("TopSpeakers on empty room = %v, want empty slice", top)
	}
}

func TestVoiceRoom_RemoveParticipant_RemovesFromDetector(t *testing.T) {
	cfg := ws.VoiceRoomConfig{
		ChannelID:   3,
		TopSpeakers: 3,
	}
	room := ws.NewVoiceRoom(cfg)
	_ = room.AddParticipant(100)
	_ = room.AddParticipant(200)

	// Feed audio so both appear in top speakers.
	for range 5 {
		room.UpdateSpeakerLevel(100, 20)
		room.UpdateSpeakerLevel(200, 30)
	}

	// Verify both appear before removal.
	topBefore := room.TopSpeakers()
	if len(topBefore) < 2 {
		t.Fatalf("expected 2 speakers before removal, got %v", topBefore)
	}

	// Remove user 100 from the room.
	room.RemoveParticipant(100)

	// After removal, user 100 must not appear in TopSpeakers.
	top := room.TopSpeakers()
	for _, id := range top {
		if id == int64(100) {
			t.Errorf("removed user 100 still appears in TopSpeakers: %v", top)
		}
	}
}

func TestVoiceRoom_Config(t *testing.T) {
	cfg := ws.VoiceRoomConfig{
		ChannelID:       42,
		MaxUsers:        10,
		Quality:         "high",
		MixingThreshold: 8,
		TopSpeakers:     5,
		MaxVideo:        2,
	}
	room := ws.NewVoiceRoom(cfg)

	got := room.Config()
	if got.ChannelID != 42 {
		t.Errorf("Config().ChannelID = %d, want 42", got.ChannelID)
	}
	if got.MaxUsers != 10 {
		t.Errorf("Config().MaxUsers = %d, want 10", got.MaxUsers)
	}
	if got.Quality != "high" {
		t.Errorf("Config().Quality = %q, want %q", got.Quality, "high")
	}
	if got.MixingThreshold != 8 {
		t.Errorf("Config().MixingThreshold = %d, want 8", got.MixingThreshold)
	}
	if got.TopSpeakers != 5 {
		t.Errorf("Config().TopSpeakers = %d, want 5", got.TopSpeakers)
	}
	if got.MaxVideo != 2 {
		t.Errorf("Config().MaxVideo = %d, want 2", got.MaxVideo)
	}
}

// ─── speakerKey helper ────────────────────────────────────────────────────────

func TestSpeakerKey_Empty(t *testing.T) {
	key := ws.SpeakerKeyForTest(nil)
	if key != "" {
		t.Errorf("SpeakerKeyForTest(nil) = %q, want empty string", key)
	}

	key2 := ws.SpeakerKeyForTest([]int64{})
	if key2 != "" {
		t.Errorf("SpeakerKeyForTest([]) = %q, want empty string", key2)
	}
}

func TestSpeakerKey_SingleSpeaker(t *testing.T) {
	key := ws.SpeakerKeyForTest([]int64{42})
	if key == "" {
		t.Error("SpeakerKeyForTest([42]) returned empty string")
	}
	// Key must contain the speaker ID in some form.
	if key != "42" {
		t.Errorf("SpeakerKeyForTest([42]) = %q, want %q", key, "42")
	}
}

func TestSpeakerKey_MultipleSpeakers(t *testing.T) {
	key1 := ws.SpeakerKeyForTest([]int64{1, 2, 3})
	key2 := ws.SpeakerKeyForTest([]int64{1, 2, 3})
	key3 := ws.SpeakerKeyForTest([]int64{3, 2, 1})

	// Same order → same key.
	if key1 != key2 {
		t.Errorf("same speaker lists produced different keys: %q vs %q", key1, key2)
	}
	// Different order → different key (order matters for change detection).
	if key1 == key3 {
		t.Errorf("different speaker order should produce different keys but got %q for both", key1)
	}
}

func TestSpeakerKey_DistinctFromDifferentSpeakers(t *testing.T) {
	key1 := ws.SpeakerKeyForTest([]int64{1, 2})
	key2 := ws.SpeakerKeyForTest([]int64{1, 3})
	if key1 == key2 {
		t.Errorf("different speaker sets should produce different keys, both got %q", key1)
	}
}

// ─── Speaker broadcast integration ───────────────────────────────────────────

// TestSpeakerBroadcast_Integration creates a hub with a voice room, feeds
// speaker levels, and verifies a voice_speakers broadcast is sent within the
// ticker interval.
func TestSpeakerBroadcast_Integration(t *testing.T) {
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Create a voice room for channel 99.
	cfg := ws.VoiceRoomConfig{
		ChannelID:   99,
		TopSpeakers: 3,
	}
	room := hub.GetOrCreateVoiceRoom(99, cfg)

	// Register a client subscribed to channel 99 to receive the broadcast.
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithChannel(hub, 1, 99, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Feed audio levels into the room — make user 1 a speaker.
	for range 5 {
		room.UpdateSpeakerLevel(1, 20) // level=20 (dBov), well below silence threshold
	}

	// Wait for at least two ticker intervals (200ms each) so the broadcast fires.
	time.Sleep(500 * time.Millisecond)

	// Drain and look for a voice_speakers message.
	var found bool
drainLoop:
	for {
		select {
		case msg := <-send:
			var env map[string]json.RawMessage
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			msgType, ok := env["type"]
			if !ok {
				continue
			}
			var t2 string
			if err := json.Unmarshal(msgType, &t2); err != nil {
				continue
			}
			if t2 == "voice_speakers" {
				found = true
				break drainLoop
			}
		default:
			break drainLoop
		}
	}

	if !found {
		t.Error("expected voice_speakers broadcast within ticker interval, none received")
	}
}

// TestSpeakerBroadcast_NoBroadcastWhenNoChange verifies that the ticker does
// not repeatedly broadcast when the speaker list has not changed.
func TestSpeakerBroadcast_NoBroadcastWhenNoChange(t *testing.T) {
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	cfg := ws.VoiceRoomConfig{
		ChannelID:   100,
		TopSpeakers: 3,
	}
	room := hub.GetOrCreateVoiceRoom(100, cfg)

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithChannel(hub, 2, 100, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Feed levels to produce a stable speaker list.
	for range 5 {
		room.UpdateSpeakerLevel(2, 20)
	}

	// Wait for first broadcast.
	time.Sleep(300 * time.Millisecond)

	// Count how many voice_speakers messages arrived after the initial one.
	// In a change-detection implementation, subsequent ticks with the same
	// speaker list should NOT send more broadcasts.
	count := 0
	for {
		select {
		case msg := <-send:
			var env map[string]json.RawMessage
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			var msgType string
			if raw, ok := env["type"]; ok {
				_ = json.Unmarshal(raw, &msgType)
			}
			if msgType == "voice_speakers" {
				count++
			}
		default:
			goto done
		}
	}
done:
	// We allow 1 broadcast (initial detection), but not many repeated ones.
	// If every tick sent a message, we'd see ~2-4 in 300ms. We cap at 2.
	if count > 2 {
		t.Errorf("expected at most 2 voice_speakers broadcasts (dedup), got %d", count)
	}
}

// TestSpeakerBroadcast_RoomCleanup verifies that when a voice room is removed,
// the ticker cleans up its stale prevSpeakers entry so that re-creating the
// room with an active speaker triggers a new broadcast.
func TestSpeakerBroadcast_RoomCleanup(t *testing.T) {
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	const chanID = int64(101)
	cfg := ws.VoiceRoomConfig{
		ChannelID:   chanID,
		TopSpeakers: 3,
	}
	room := hub.GetOrCreateVoiceRoom(chanID, cfg)

	// Use a large buffer to avoid missing messages due to timing.
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithChannel(hub, 3, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Feed levels so the ticker broadcasts at least once.
	for range 5 {
		room.UpdateSpeakerLevel(3, 20)
	}

	// Wait for two ticker intervals to ensure at least one broadcast fires.
	time.Sleep(500 * time.Millisecond)

	// Remove the room; this should cause the ticker to clean up prevSpeakers.
	hub.RemoveVoiceRoom(chanID)

	// Wait one more tick to let the cleanup run.
	time.Sleep(250 * time.Millisecond)

	// Drain all pending messages.
	draining:
	for {
		select {
		case <-send:
		default:
			break draining
		}
	}

	// Re-create the room and feed a new speaker — the ticker should broadcast
	// again because prevSpeakers[chanID] was deleted when the room was removed.
	newRoom := hub.GetOrCreateVoiceRoom(chanID, cfg)
	for range 5 {
		newRoom.UpdateSpeakerLevel(3, 20)
	}

	// Wait for the ticker to detect the new room and broadcast.
	time.Sleep(500 * time.Millisecond)

	var found bool
	collectLoop:
	for {
		select {
		case msg := <-send:
			var env map[string]json.RawMessage
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			var msgType string
			if raw, ok := env["type"]; ok {
				_ = json.Unmarshal(raw, &msgType)
			}
			if msgType == "voice_speakers" {
				found = true
				break collectLoop
			}
		default:
			break collectLoop
		}
	}

	if !found {
		t.Error("expected voice_speakers broadcast after room re-creation, none received")
	}
}
