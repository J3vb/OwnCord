package ws_test

import (
	"slices"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

func TestNewSpeakerDetector(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetector(3)
	if sd == nil {
		t.Fatal("NewSpeakerDetector returned nil")
	}
	top := sd.TopSpeakers()
	if len(top) != 0 {
		t.Fatalf("expected empty top speakers, got %v", top)
	}
}

func TestSpeakerDetector_UpdateLevel(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetector(3)

	// Feed several level samples for a single user.
	for range 5 {
		sd.UpdateLevel(1, 30) // relatively loud
	}

	top := sd.TopSpeakers()
	if len(top) != 1 {
		t.Fatalf("expected 1 speaker, got %d", len(top))
	}
	if top[0] != int64(1) {
		t.Fatalf("expected userID 1, got %d", top[0])
	}
}

func TestSpeakerDetector_TopSpeakers_RankedByLoudest(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetector(3)

	// 5 users with different average levels (lower = louder in dBov).
	// User 10: level 10 (loudest)
	// User 20: level 30
	// User 30: level 50
	// User 40: level 80
	// User 50: level 100 (quietest)
	users := []struct {
		id    int64
		level uint8
	}{
		{10, 10},
		{20, 30},
		{30, 50},
		{40, 80},
		{50, 100},
	}
	for _, u := range users {
		for range 5 {
			sd.UpdateLevel(u.id, u.level)
		}
	}

	top := sd.TopSpeakers()
	if len(top) != 3 {
		t.Fatalf("expected 3 top speakers, got %d: %v", len(top), top)
	}
	// Should be sorted loudest first: 10, 20, 30
	expected := []int64{10, 20, 30}
	for i, want := range expected {
		if top[i] != want {
			t.Errorf("top[%d] = %d, want %d", i, top[i], want)
		}
	}
}

func TestSpeakerDetector_TopSpeakers_SilentExcluded(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetector(3)

	// User 1: loud
	for range 5 {
		sd.UpdateLevel(1, 20)
	}
	// User 2: completely silent (127 = digital silence in RFC 6464)
	for range 5 {
		sd.UpdateLevel(2, 127)
	}

	top := sd.TopSpeakers()
	if len(top) != 1 {
		t.Fatalf("expected 1 speaker (silent excluded), got %d: %v", len(top), top)
	}
	if top[0] != int64(1) {
		t.Fatalf("expected userID 1, got %d", top[0])
	}
}

func TestSpeakerDetector_TopSpeakers_HoldoffKeepsSpeaker(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetectorWithHoldoff(3, 50*time.Millisecond)

	// User 1 speaks loudly.
	for range 5 {
		sd.UpdateLevel(1, 20)
	}

	// User 1 goes silent.
	for range 10 {
		sd.UpdateLevel(1, 127)
	}

	// Immediately check — holdoff should keep user 1 in top speakers.
	top := sd.TopSpeakers()
	if !slices.Contains(top, int64(1)) {
		t.Fatalf("expected user 1 to remain in top speakers during holdoff, got %v", top)
	}
}

func TestSpeakerDetector_TopSpeakers_HoldoffExpires(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetectorWithHoldoff(3, 50*time.Millisecond)

	// User 1 speaks loudly.
	for range 5 {
		sd.UpdateLevel(1, 20)
	}

	// User 1 goes silent — fill ring buffer with silence.
	for range 10 {
		sd.UpdateLevel(1, 127)
	}

	// Wait longer than holdoff.
	time.Sleep(80 * time.Millisecond)

	top := sd.TopSpeakers()
	for _, id := range top {
		if id == int64(1) {
			t.Fatalf("expected user 1 to be evicted after holdoff expired, got %v", top)
		}
	}
}

func TestSpeakerDetector_RemoveSpeaker(t *testing.T) {
	t.Parallel()
	sd := ws.NewSpeakerDetector(3)

	for range 5 {
		sd.UpdateLevel(1, 20)
		sd.UpdateLevel(2, 30)
	}

	sd.RemoveSpeaker(1)

	top := sd.TopSpeakers()
	for _, id := range top {
		if id == int64(1) {
			t.Fatalf("removed speaker should not appear in TopSpeakers, got %v", top)
		}
	}
	if len(top) != 1 || top[0] != int64(2) {
		t.Fatalf("expected [2], got %v", top)
	}
}

func TestParseAudioLevel_Valid(t *testing.T) {
	t.Parallel()

	// Construct a one-byte header extension value:
	// V=1, Level=42 → binary: 1_0101010 → 0xAA
	extByte := byte(0x80 | 42) // voice=1, level=42
	// RFC 5285 one-byte header format: 4-bit ID | 4-bit length-1
	// For extensionID=1, length=1 byte: header = 0x10
	extensionID := uint8(1)
	buf := []byte{extensionID << 4, extByte} // ID=1, L=0 (meaning 1 byte), then the data byte

	level, voice, ok := ws.ParseAudioLevel(buf, extensionID)
	if !ok {
		t.Fatal("expected ok=true for valid extension")
	}
	if level != 42 {
		t.Errorf("level = %d, want 42", level)
	}
	if !voice {
		t.Error("expected voice=true")
	}

	// Test with voice=false, level=10 → binary: 0_0001010 → 0x0A
	extByte2 := byte(10) // voice=0, level=10
	buf2 := []byte{extensionID << 4, extByte2}

	level2, voice2, ok2 := ws.ParseAudioLevel(buf2, extensionID)
	if !ok2 {
		t.Fatal("expected ok=true")
	}
	if level2 != 10 {
		t.Errorf("level = %d, want 10", level2)
	}
	if voice2 {
		t.Error("expected voice=false")
	}
}

func TestParseAudioLevel_NotFound(t *testing.T) {
	t.Parallel()

	// Empty buffer.
	_, _, ok := ws.ParseAudioLevel(nil, 1)
	if ok {
		t.Error("expected ok=false for nil buffer")
	}

	_, _, ok = ws.ParseAudioLevel([]byte{}, 1)
	if ok {
		t.Error("expected ok=false for empty buffer")
	}

	// Wrong extension ID — buffer has ID=2 but we ask for ID=1.
	buf := []byte{2 << 4, 0x80}
	_, _, ok = ws.ParseAudioLevel(buf, 1)
	if ok {
		t.Error("expected ok=false for wrong extension ID")
	}
}
