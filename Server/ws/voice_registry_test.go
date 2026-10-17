package ws

import "testing"

// TestVoiceSlot_ZeroValueIsNotInVoice pins WP 5.3a's edge case: tests build
// clients as &Client{} literals and hubs without a voice constructor, so the
// zero voiceSlot and the zero voiceRegistry must already mean "not in voice,
// nothing parked" and be safe to use.
func TestVoiceSlot_ZeroValueIsNotInVoice(t *testing.T) {
	c := &Client{}

	if got := c.getVoiceChID(); got != 0 {
		t.Fatalf("zero client voice channel = %d, want 0", got)
	}
	if ch, tok := c.getVoiceState(); ch != 0 || tok != "" {
		t.Fatalf("zero client voice state = (%d, %q), want (0, \"\")", ch, tok)
	}
	if muted, deafened, by := c.takePendingModFlags(); muted || deafened || by != nil {
		t.Fatalf("zero client mod stash = (%v, %v, %v), want none", muted, deafened, by)
	}
	if a := c.getE2EEAnnounce(); a.key != "" || a.sig != "" || a.videoDecode != nil {
		t.Fatalf("zero client e2ee announce = %+v, want empty", a)
	}
	if c.markVoiceJoinCompleteIfMatch(1, "tok") {
		t.Fatal("zero client marked a join complete it never started")
	}
	if _, ok := c.clearExact(1, "tok"); ok {
		t.Fatal("zero client matched an exact-join clear")
	}
	if ch, tok, completed := c.clearVoiceState(); ch != 0 || tok != "" || completed {
		t.Fatalf("zero client clear returned (%d, %q, %v), want (0, \"\", false)", ch, tok, completed)
	}

	var r voiceRegistry
	r.voiceMember.lock(1)()
	if r.voiceGrace.get(1) != nil || r.voiceGrace.has(1, 0) || len(r.voiceGrace.snapshot()) != 0 {
		t.Fatal("zero registry has a parked membership")
	}
	if r.voiceGrace.take(1) != nil {
		t.Fatal("zero registry handed out a parked membership")
	}
}
