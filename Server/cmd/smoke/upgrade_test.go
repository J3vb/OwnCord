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
			// The wanted substring carries a word of the message as well as
			// the version, so the case stays pinned to the version branch: a
			// bare "1.2.0-alpha.4" is echoed by any error that happens to
			// mention a version, including ones from compare().
			name:        "an unchanged version fails even though nothing else moved",
			mutateAfter: func(s *state) { s.version = baseState().version },
			wantErr:     "is still " + baseState().version,
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

// TestRestored is the phase-8 counterpart, and the case that matters is the
// mirror image of TestUpgraded's: a rollback that silently kept serving the
// new binary leaves every other assertion true, because the data directory
// really was restored.
func TestRestored(t *testing.T) {
	tests := []struct {
		name             string
		mutateRolledBack func(s *state)
		wantErr          string // substring the error must name; "" means no error
	}{
		{
			// The shape of a real rollback: the pre-upgrade version is back
			// and everything the pre-upgrade capture recorded is back with it.
			name: "the pre-upgrade state served by the pre-upgrade version passes",
		},
		{
			name:             "the new version still serving fails",
			mutateRolledBack: func(s *state) { s.version = "dev" },
			wantErr:          "want the pre-upgrade " + baseState().version,
		},
		{
			// The inverted-archive proof in code: an archive that dropped
			// data/uploads restores an install without the attachment.
			name:             "an attachment the archive did not carry is named",
			mutateRolledBack: func(s *state) { delete(s.uploads, "9f1c-attachment") },
			wantErr:          "9f1c-attachment",
		},
		{
			name:             "a credential file the archive did not carry is named",
			mutateRolledBack: func(s *state) { delete(s.keys, "data/totp.key") },
			wantErr:          "totp.key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := clone(baseState())
			rolledBack := clone(baseState())
			if tt.mutateRolledBack != nil {
				tt.mutateRolledBack(&rolledBack)
			}
			err := restored(before, rolledBack)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("restored() = %v, want no error", err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("restored() = nil, want an error naming %q", tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("restored() = %q, want it to name %q", err, tt.wantErr)
			}
		})
	}
}
