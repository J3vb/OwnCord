package main

import (
	"bytes"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/storage"
)

// baseState is one captured install, populated in every field compare looks
// at. Each case below mutates a copy, so a case that forgets to mutate fails
// loudly as "identical states" rather than passing on an empty struct.
func baseState() state {
	return state{
		config: "cfg-1",
		keys: map[string]string{
			"data/totp.key":       "totp-1",
			"data/erasure.key":    "erasure-1",
			"data/push_vapid.key": "vapid-1",
		},
		uploads: map[string]string{
			"9f1c-attachment": "upload-1",
			"nested/other":    "upload-2",
		},
		backups: []string{"chatserver_20260912_101500.db"},
		download: download{
			id:     "9f1c-attachment",
			digest: "download-1",
			length: 65536,
		},
		version: "1.2.0-alpha.4",
	}
}

func clone(s state) state {
	out := s
	out.keys = maps.Clone(s.keys)
	out.uploads = maps.Clone(s.uploads)
	out.backups = slices.Clone(s.backups)
	return out
}

func TestCompare(t *testing.T) {
	tests := []struct {
		name string
		// before and after are mutated separately because the interesting
		// asymmetry — a file the newer version creates on first boot — only
		// exists when before is the one missing an entry.
		mutateBefore func(s *state)
		mutateAfter  func(s *state)
		wantErr      string // substring the error must name; "" means no error
		wantAdded    string // substring the informational line must name
	}{
		{
			name: "two equal states compare clean",
		},
		{
			// The whole point of compare: an owner reading CI output has to be
			// told which of five nouns moved. "state differs" would pass this
			// test for the wrong reason, so the assertion is on the name.
			name:        "a rewritten key file is named",
			mutateAfter: func(s *state) { s.keys["data/push_vapid.key"] = "vapid-2" },
			wantErr:     "push_vapid.key",
		},
		{
			// Losing a credential file is the worst outcome the rehearsal can
			// have — every push subscription is dead — and it is invisible to
			// any check that only compares the digests both sides have.
			name:        "a key file that was present and is now absent fails",
			mutateAfter: func(s *state) { delete(s.keys, "data/push_vapid.key") },
			wantErr:     "push_vapid.key",
		},
		{
			// Ruling A. alpha.4 ships no push_vapid_key.go at all, so HEAD
			// legitimately creates data/push_vapid.key on its first boot.
			// Byte-equality would fail the rehearsal for a newer server doing
			// exactly what it should.
			name:         "a key file absent before and present after is informational",
			mutateBefore: func(s *state) { delete(s.keys, "data/push_vapid.key") },
			wantAdded:    "push_vapid.key",
		},
		{
			// The re-issued download is the "authenticated downloads still
			// work" half of the milestone; naming the id is what tells an
			// owner which attachment came back wrong.
			name:        "a rewritten attachment names the file id",
			mutateAfter: func(s *state) { s.download.digest = "download-2" },
			wantErr:     "9f1c-attachment",
		},
		{
			name:        "a truncated attachment names the file id",
			mutateAfter: func(s *state) { s.download.length = 1024 },
			wantErr:     "9f1c-attachment",
		},
		{
			name:        "a lost upload names its relative path",
			mutateAfter: func(s *state) { delete(s.uploads, "nested/other") },
			wantErr:     "nested/other",
		},
		{
			name:        "a rewritten upload names its relative path",
			mutateAfter: func(s *state) { s.uploads["nested/other"] = "upload-3" },
			wantErr:     "nested/other",
		},
		{
			name:        "an upload only the newer version has is informational",
			mutateAfter: func(s *state) { s.uploads["brand-new"] = "upload-4" },
			wantAdded:   "brand-new",
		},
		{
			name:        "a rewritten config.yaml is named",
			mutateAfter: func(s *state) { s.config = "cfg-2" },
			wantErr:     "config.yaml",
		},
		{
			name:        "a backup missing from the list is named",
			mutateAfter: func(s *state) { s.backups = nil },
			wantErr:     "chatserver_20260912_101500.db",
		},
		{
			name:        "a backup only the newer install has is informational",
			mutateAfter: func(s *state) { s.backups = append(s.backups, "chatserver_20260912_120000.db") },
			wantAdded:   "chatserver_20260912_120000.db",
		},
		{
			// The upgrade EXPECTS the version to differ and the rollback
			// expects it to match, so compare cannot hold an opinion; the
			// caller asserts it in whichever direction its phase needs.
			name:        "a differing version is not compare's business",
			mutateAfter: func(s *state) { s.version = "dev" },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before, after := clone(baseState()), clone(baseState())
			if tt.mutateBefore != nil {
				tt.mutateBefore(&before)
			}
			if tt.mutateAfter != nil {
				tt.mutateAfter(&after)
			}

			err := compare(before, after)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("compare() = %v, want no error", err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("compare() = nil, want an error naming %q", tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("compare() = %q, want it to name %q", err, tt.wantErr)
			}

			added := additions(before, after)
			if tt.wantAdded == "" {
				if added != "" {
					t.Fatalf("additions() = %q, want nothing reported as added", added)
				}
				return
			}
			if !strings.Contains(added, tt.wantAdded) {
				t.Fatalf("additions() = %q, want it to mention %q", added, tt.wantAdded)
			}
		})
	}
}

// TestFixturePayloadIsDeterministic guards the one property the whole
// attachment assertion rests on: the same bytes on every run and on every
// platform. crypto/rand here would make the pre-upgrade and post-upgrade
// digests differ for a reason that has nothing to do with the upgrade.
func TestFixturePayloadIsDeterministic(t *testing.T) {
	first, second := fixturePayload(), fixturePayload()
	if len(first) != fixturePayloadSize {
		t.Fatalf("fixturePayload() is %d bytes, want %d", len(first), fixturePayloadSize)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("fixturePayload() returned different bytes on two calls")
	}
	// The upload path rejects known-executable magic bytes, and it is the
	// server's own table that decides which — so ask it rather than copying
	// the list. A payload that happened to start with one would fail the
	// fixture with a 400 that reads like a server defect.
	if err := storage.ValidateFileType(first[:8]); err != nil {
		t.Fatalf("fixturePayload() is not uploadable: %v", err)
	}
}
