package ws_test

import (
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/owncord/server/ws"
)

func defaultRoomConfig() ws.VoiceRoomConfig {
	return ws.VoiceRoomConfig{
		ChannelID:       1,
		MaxUsers:        0,
		Quality:         "medium",
		MixingThreshold: 5,
		TopSpeakers:     3,
		MaxVideo:        4,
	}
}

func TestNewVoiceRoom(t *testing.T) {
	cfg := defaultRoomConfig()
	room := ws.NewVoiceRoom(cfg)

	if room.Mode() != "forwarding" {
		t.Errorf("NewVoiceRoom() mode = %q, want %q", room.Mode(), "forwarding")
	}
	if !room.IsEmpty() {
		t.Error("NewVoiceRoom() should be empty")
	}
	if room.ParticipantCount() != 0 {
		t.Errorf("NewVoiceRoom() count = %d, want 0", room.ParticipantCount())
	}
}

func TestVoiceRoom_AddParticipant(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())

	if err := room.AddParticipant(100); err != nil {
		t.Fatalf("AddParticipant(100) returned error: %v", err)
	}
	if err := room.AddParticipant(200); err != nil {
		t.Fatalf("AddParticipant(200) returned error: %v", err)
	}

	if room.ParticipantCount() != 2 {
		t.Errorf("ParticipantCount() = %d, want 2", room.ParticipantCount())
	}
	if room.IsEmpty() {
		t.Error("room should not be empty after adding participants")
	}
}

func TestVoiceRoom_AddParticipant_Full(t *testing.T) {
	cfg := defaultRoomConfig()
	cfg.MaxUsers = 2
	room := ws.NewVoiceRoom(cfg)

	if err := room.AddParticipant(1); err != nil {
		t.Fatalf("AddParticipant(1) returned error: %v", err)
	}
	if err := room.AddParticipant(2); err != nil {
		t.Fatalf("AddParticipant(2) returned error: %v", err)
	}

	err := room.AddParticipant(3)
	if err == nil {
		t.Fatal("AddParticipant(3) should return error when room is full")
	}
	if !errors.Is(err, ws.ErrRoomFull) {
		t.Errorf("error = %v, want ErrRoomFull", err)
	}
	if room.ParticipantCount() != 2 {
		t.Errorf("ParticipantCount() = %d, want 2 (third should not be added)", room.ParticipantCount())
	}
}

func TestVoiceRoom_AddParticipant_Unlimited(t *testing.T) {
	cfg := defaultRoomConfig()
	cfg.MaxUsers = 0
	room := ws.NewVoiceRoom(cfg)

	for i := int64(1); i <= 50; i++ {
		if err := room.AddParticipant(i); err != nil {
			t.Fatalf("AddParticipant(%d) returned error: %v", i, err)
		}
	}
	if room.ParticipantCount() != 50 {
		t.Errorf("ParticipantCount() = %d, want 50", room.ParticipantCount())
	}
}

func TestVoiceRoom_RemoveParticipant(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(1)
	_ = room.AddParticipant(2)
	_ = room.AddParticipant(3)

	room.RemoveParticipant(2)

	if room.ParticipantCount() != 2 {
		t.Errorf("ParticipantCount() = %d, want 2", room.ParticipantCount())
	}
	if room.HasParticipant(2) {
		t.Error("HasParticipant(2) = true after removal")
	}
}

func TestVoiceRoom_RemoveParticipant_NotPresent(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(1)

	// Should not panic.
	room.RemoveParticipant(999)

	if room.ParticipantCount() != 1 {
		t.Errorf("ParticipantCount() = %d, want 1", room.ParticipantCount())
	}
}

func TestVoiceRoom_HasParticipant(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(42)

	if !room.HasParticipant(42) {
		t.Error("HasParticipant(42) = false, want true")
	}
	if room.HasParticipant(99) {
		t.Error("HasParticipant(99) = true, want false")
	}
}

func TestVoiceRoom_ParticipantIDs(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(10)
	_ = room.AddParticipant(20)
	_ = room.AddParticipant(30)

	ids := room.ParticipantIDs()
	if len(ids) != 3 {
		t.Fatalf("ParticipantIDs() returned %d IDs, want 3", len(ids))
	}

	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	want := []int64{10, 20, 30}
	for i, id := range ids {
		if id != want[i] {
			t.Errorf("ParticipantIDs()[%d] = %d, want %d", i, id, want[i])
		}
	}
}

func TestVoiceRoom_Mode_ForwardingToSelective(t *testing.T) {
	cfg := defaultRoomConfig()
	cfg.MixingThreshold = 3
	room := ws.NewVoiceRoom(cfg)

	_ = room.AddParticipant(1)
	_ = room.AddParticipant(2)
	if room.Mode() != "forwarding" {
		t.Errorf("mode after 2 users = %q, want %q", room.Mode(), "forwarding")
	}

	_ = room.AddParticipant(3)
	if room.Mode() != "selective" {
		t.Errorf("mode after 3 users (threshold=3) = %q, want %q", room.Mode(), "selective")
	}
}

func TestVoiceRoom_Mode_SelectiveToForwarding_Hysteresis(t *testing.T) {
	cfg := defaultRoomConfig()
	cfg.MixingThreshold = 5
	room := ws.NewVoiceRoom(cfg)

	// Add 5 participants to trigger selective mode.
	for i := int64(1); i <= 5; i++ {
		_ = room.AddParticipant(i)
	}
	if room.Mode() != "selective" {
		t.Fatalf("mode after 5 users (threshold=5) = %q, want %q", room.Mode(), "selective")
	}

	// Remove 1: count=4, still selective (4 > 5-2=3).
	room.RemoveParticipant(5)
	if room.Mode() != "selective" {
		t.Errorf("mode at count=4 should still be %q (hysteresis), got %q", "selective", room.Mode())
	}

	// Remove 1 more: count=3, 3 <= 5-2=3 → switch to forwarding.
	room.RemoveParticipant(4)
	if room.Mode() != "forwarding" {
		t.Errorf("mode at count=3 should be %q (3 <= threshold-2=3), got %q", "forwarding", room.Mode())
	}
}

func TestVoiceRoom_Close(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(1)
	_ = room.AddParticipant(2)

	room.Close()

	if !room.IsEmpty() {
		t.Error("room should be empty after Close()")
	}
	if room.ParticipantCount() != 0 {
		t.Errorf("ParticipantCount() = %d after Close(), want 0", room.ParticipantCount())
	}
}

func TestVoiceRoom_Concurrent(t *testing.T) {
	cfg := defaultRoomConfig()
	cfg.MaxUsers = 0
	room := ws.NewVoiceRoom(cfg)

	var wg sync.WaitGroup
	const goroutines = 50

	// Add participants concurrently.
	for i := int64(1); i <= goroutines; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			_ = room.AddParticipant(id)
		}(i)
	}
	wg.Wait()

	if room.ParticipantCount() != goroutines {
		t.Errorf("ParticipantCount() = %d after concurrent adds, want %d", room.ParticipantCount(), goroutines)
	}

	// Remove participants concurrently.
	for i := int64(1); i <= goroutines; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			room.RemoveParticipant(id)
		}(i)
	}
	wg.Wait()

	if !room.IsEmpty() {
		t.Errorf("room should be empty after concurrent removes, count = %d", room.ParticipantCount())
	}

	// Mix add/remove concurrently.
	for i := int64(1); i <= goroutines; i++ {
		wg.Add(2)
		go func(id int64) {
			defer wg.Done()
			_ = room.AddParticipant(id)
		}(i)
		go func(id int64) {
			defer wg.Done()
			room.RemoveParticipant(id)
		}(i)
	}
	wg.Wait()

	// Just verify no panic and count is non-negative.
	if room.ParticipantCount() < 0 {
		t.Errorf("ParticipantCount() = %d, should not be negative", room.ParticipantCount())
	}
}

func TestVoiceRoom_AddParticipant_Duplicate(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(1)
	_ = room.AddParticipant(1) // duplicate

	// Should not double-count.
	if room.ParticipantCount() != 1 {
		t.Errorf("ParticipantCount() = %d after duplicate add, want 1", room.ParticipantCount())
	}
}

func TestVoiceRoom_AddTrack(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(100)
	room.SetTrack(100, "audio", nil, nil)
	tracks := room.GetTracks()
	if len(tracks) != 1 {
		t.Fatalf("GetTracks() len = %d, want 1", len(tracks))
	}
}

func TestVoiceRoom_RemoveTrack(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(100)
	room.SetTrack(100, "audio", nil, nil)
	vt := room.RemoveTrack(100, "audio")
	if vt == nil {
		t.Fatal("RemoveTrack returned nil")
	}
	tracks := room.GetTracks()
	if len(tracks) != 0 {
		t.Fatalf("GetTracks() after remove len = %d, want 0", len(tracks))
	}
}

func TestVoiceRoom_GetTrackUserIDs(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(100)
	_ = room.AddParticipant(200)
	room.SetTrack(100, "audio", nil, nil)
	room.SetTrack(200, "audio", nil, nil)
	ids := room.TrackUserIDs()
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if len(ids) != 2 || ids[0] != 100 || ids[1] != 200 {
		t.Fatalf("TrackUserIDs() = %v, want [100 200]", ids)
	}
}

func TestVoiceRoom_Close_ClearsTracks(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(100)
	room.SetTrack(100, "audio", nil, nil)
	room.Close()
	if len(room.GetTracks()) != 0 {
		t.Fatal("Close() should clear tracks")
	}
}

func TestVoiceTrack_AddRemoveSender(t *testing.T) {
	room := ws.NewVoiceRoom(defaultRoomConfig())
	_ = room.AddParticipant(100)
	room.SetTrack(100, "audio", nil, nil)
	vt := room.GetTrack(100, "audio")
	if vt == nil {
		t.Fatal("GetTrack returned nil")
	}
	// AddSender with nil (unit test, no real sender)
	vt.AddSender(200, nil)
	senders := vt.CopySenders()
	if len(senders) != 1 {
		t.Fatalf("CopySenders len = %d, want 1", len(senders))
	}
	vt.RemoveSender(200)
	senders = vt.CopySenders()
	if len(senders) != 0 {
		t.Fatalf("CopySenders after remove len = %d, want 0", len(senders))
	}
}
