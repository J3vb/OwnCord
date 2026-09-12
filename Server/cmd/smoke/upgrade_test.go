package main

import (
	"strings"
	"testing"
)

// TestUpgraded covers the phase-5 assertions that need no server. The one
// that matters most is the version: it is the only assertion in the whole
// rehearsal that fails when the upgrade silently did not happen, so a
// regression here would make every other phase pass over the old binary.
func TestUpgraded(t *testing.T) {
	f := fixture{attachmentID: "9f1c-attachment", backupName: "chatserver_20260912_101500.db"}

	tests := []struct {
		name        string
		mutateAfter func(s *state)
		wantErr     string // substring the error must name; "" means no error
	}{
		{
			// The shape of a real upgrade: a new version, everything the old
			// one had still there, plus whatever the newer version created on
			// its first boot. compare() tolerates the addition (Ruling A), so
			// upgraded() must too.
			name:        "a new version that preserved the install passes",
			mutateAfter: func(s *state) { s.uploads["created-by-the-newer-version"] = "u-3" },
		},
		{
			name:        "an unchanged version fails even though nothing else moved",
			mutateAfter: func(s *state) { s.version = baseState().version },
			wantErr:     baseState().version,
		},
		{
			name:        "a swept pre-upgrade backup fails",
			mutateAfter: func(s *state) { s.backups = nil },
			wantErr:     "chatserver_20260912_101500.db",
		},
		{
			// upgraded() must not lose what compare() found; this is the only
			// route by which a lost upload reaches a phase-5 failure.
			name:        "a lost upload is reported through compare",
			mutateAfter: func(s *state) { delete(s.uploads, "9f1c-attachment") },
			wantErr:     "9f1c-attachment",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := clone(baseState())
			after := clone(baseState())
			after.version = "dev" // the upgrade, unless a case undoes it
			if tt.mutateAfter != nil {
				tt.mutateAfter(&after)
			}
			err := upgraded(f, before, after)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("upgraded() = %v, want no error", err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("upgraded() = nil, want an error naming %q", tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("upgraded() = %q, want it to name %q", err, tt.wantErr)
			}
		})
	}
}
