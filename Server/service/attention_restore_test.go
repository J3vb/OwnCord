package service

import "testing"

// WP 5.5: a staged restore handled at boot shows on the panel. Without one
// there is no signal at all.
func TestAttention_RestoreOutcome(t *testing.T) {
	f := newAttentionFixture(t)
	for _, s := range f.step().Signals {
		if s.ID == "last_restore" {
			t.Fatal("a start with no restore reported a last_restore signal")
		}
	}

	f.s.RecordRestoreOutcome(RestoreOutcome{Recorded: true, Status: "applied", Backup: "chatserver_x.db", At: f.now})
	rep := f.step()
	wantStatus(t, rep, "last_restore", AttentionStatusOK)
	if got := signal(t, rep, "last_restore").Value; got == "" {
		t.Error("an applied restore has no value naming the backup and time")
	}
	if w := warning(rep, "last_restore"); w != nil {
		t.Fatalf("an applied restore raised a warning: %+v", w)
	}

	f = newAttentionFixture(t)
	f.s.RecordRestoreOutcome(RestoreOutcome{Recorded: true, Status: "rolled_back", Backup: "chatserver_x.db", At: f.now, Reason: "integrity"})
	rep = f.step()
	wantStatus(t, rep, "last_restore", AttentionStatusWarning)
	w := warning(rep, "last_restore")
	if w == nil || w.Title == "" || w.Action == "" || w.Detail == "" {
		t.Fatalf("a rolled-back restore warning = %+v, want title, action and detail", w)
	}
}
