package main

import (
	"strings"
	"testing"
)

// TestParsePhases pins the -phases parser. It is unit-tested rather than
// exercised through a run because its two real failure modes are both silent
// in a green log: a spec that selects nothing would print no phase and exit 0
// (a drill that ran nothing reporting success), and a spec that selects more
// than was asked for would run a phase the caller deliberately excluded —
// phase D on a machine with no tmpfs, say.
func TestParsePhases(t *testing.T) {
	tests := []struct {
		name    string
		spec    string
		want    string // the letters, in run order
		wantErr string // substring the error must name; "" means no error
	}{
		{
			// The default is all of them: the flag exists to NARROW a run, so
			// an absent flag must not mean "run no drills".
			name: "the empty spec runs every phase",
			spec: "",
			want: "RCDS",
		},
		{name: "R alone", spec: "R", want: "R"},
		{name: "C alone", spec: "C", want: "C"},
		{name: "D alone", spec: "D", want: "D"},
		{name: "S alone", spec: "S", want: "S"},
		{
			// Order is the plan's numbering, not the caller's typing: a phase
			// may depend on what an earlier one left in the install directory.
			name: "letters run in the numbered order, not the order given",
			spec: "SR",
			want: "RS",
		},
		{name: "several letters in one word", spec: "RC", want: "RC"},
		{name: "commas separate letters", spec: "R,C", want: "RC"},
		{name: "spaces are tolerated", spec: "R C", want: "RC"},
		{
			// An unknown letter is a usage error, never a skip: a caller who
			// typed -phases X believes X ran, and a skip would tell them it did.
			name:    "an unknown letter is a usage error",
			spec:    "RX",
			wantErr: `unknown phase "X"`,
		},
		{
			name:    "a lowercase letter is not a phase",
			spec:    "d",
			wantErr: `unknown phase "d"`,
		},
		{
			name:    "a spec of separators only is a usage error, not an empty run",
			spec:    ",,",
			wantErr: "no phase letters",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePhases(tt.spec)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("parsePhases(%q) = %v, want no error", tt.spec, err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("parsePhases(%q) = %q, want an error naming %q", tt.spec, phaseLetters(got), tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("parsePhases(%q) = %q, want it to name %q", tt.spec, err, tt.wantErr)
			case tt.wantErr != "":
				return
			}
			if got := phaseLetters(got); got != tt.want {
				t.Fatalf("parsePhases(%q) = %q, want %q", tt.spec, got, tt.want)
			}
		})
	}
}

// fixtureLedger is the real ledger's shape, small enough to read. The real one
// (R14) holds 444 rows and not one open finding, so a unit test against it
// could only ever walk the "not open" branch — every downgrade case would be
// untestable, which is the half that matters.
const fixtureLedger = `{
  "nextId": 4,
  "findings": [
    {"id": "OC-0001", "status": "open"},
    {"id": "OC-0002", "status": "fixed"},
    {"id": "OC-0003", "status": "open"}
  ]
}`

func fixtureKnown(t *testing.T, spec string, release bool) known {
	t.Helper()
	l, err := parseLedger([]byte(fixtureLedger))
	if err != nil {
		t.Fatalf("parseLedger: %v", err)
	}
	k, err := newKnown(spec, l, release)
	if err != nil {
		t.Fatalf("newKnown(%q): %v", spec, err)
	}
	return k
}

// TestNewKnown covers the flag's validation. The flag is a promise about a
// specific ledger row, so an id the ledger does not list, or lists as
// something other than open, has to be refused rather than ignored: ignored,
// it would downgrade nothing and read exactly like a flag that worked.
func TestNewKnown(t *testing.T) {
	l, err := parseLedger([]byte(fixtureLedger))
	if err != nil {
		t.Fatalf("parseLedger: %v", err)
	}

	tests := []struct {
		name    string
		spec    string
		wantErr string // substring; "" means accepted
	}{
		{name: "an open id is accepted", spec: "OC-0001"},
		{name: "several open ids are accepted", spec: "OC-0001,OC-0003"},
		{name: "whitespace between ids is tolerated", spec: " OC-0001 , OC-0003 "},
		{name: "the absent flag names nothing", spec: ""},
		{
			name:    "an id that is not in the ledger is refused",
			spec:    "OC-9999",
			wantErr: "not in the findings ledger",
		},
		{
			// The case R14 exists for: a fixed finding must never be usable to
			// excuse a failure, or the flag becomes a permanent hole in the
			// gate the moment the finding is repaired.
			name:    "an id the ledger lists as fixed is refused",
			spec:    "OC-0002",
			wantErr: "lists as fixed",
		},
		{
			name:    "one bad id refuses the whole flag, not just itself",
			spec:    "OC-0001,OC-9999",
			wantErr: "OC-9999",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := newKnown(tt.spec, l, true)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("newKnown(%q) = %v, want no error", tt.spec, err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("newKnown(%q) = %v, want an error naming %q", tt.spec, got.ids, tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("newKnown(%q) = %q, want it to name %q", tt.spec, err, tt.wantErr)
			}
		})
	}
}

// TestKnownTriage pins the downgrade itself. Two properties carry the weight
// and neither is visible in a green run: only a failure whose id is listed is
// downgraded (an unlisted failure in the same phase still fails the phase), and
// only on the release path (nightly and dispatch fail on exactly the same
// phase, so a known finding cannot hide from them).
func TestKnownTriage(t *testing.T) {
	listed := failure{id: "OC-0001", what: "the listed thing happened"}
	unlisted := failure{id: "OC-0003", what: "a finding nobody listed"}
	anonymous := failure{what: "a failure with no ledger row at all"}

	tests := []struct {
		name      string
		spec      string
		release   bool
		failures  []failure
		wantWarn  int
		wantFail  int
		wantNamed string // substring the first failure must carry
	}{
		{
			name:     "a listed failure warns on the release path",
			spec:     "OC-0001",
			release:  true,
			failures: []failure{listed},
			wantWarn: 1,
		},
		{
			name:     "the same failure fails everywhere else",
			spec:     "OC-0001",
			release:  false,
			failures: []failure{listed},
			wantFail: 1,
		},
		{
			name: "nothing is downgraded without the flag",
			// The ids still resolve — the ledger is the same one — but the
			// flag is what authorises the downgrade.
			spec:     "",
			release:  true,
			failures: []failure{listed},
			wantFail: 1,
		},
		{
			// The assertion that gives the flag teeth: a phase with one known
			// and one new failure must still fail on the new one.
			name:      "a phase mixing a listed and an unlisted failure fails",
			spec:      "OC-0001",
			release:   true,
			failures:  []failure{listed, unlisted},
			wantWarn:  1,
			wantFail:  1,
			wantNamed: "a finding nobody listed",
		},
		{
			// A failure the drill could not attribute to a ledger row is new by
			// definition, whatever else the phase reported.
			name:      "a failure with no id is never downgraded",
			spec:      "OC-0001",
			release:   true,
			failures:  []failure{anonymous},
			wantFail:  1,
			wantNamed: "no ledger row",
		},
		{
			name:     "a listed failure under a different id is not downgraded",
			spec:     "OC-0001",
			release:  true,
			failures: []failure{unlisted},
			wantFail: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			k := fixtureKnown(t, tt.spec, tt.release)
			fail, warn := k.triage(tt.failures)
			if len(warn) != tt.wantWarn {
				t.Errorf("triage downgraded %d failure(s) to warnings, want %d", len(warn), tt.wantWarn)
			}
			if len(fail) != tt.wantFail {
				t.Errorf("triage kept %d failure(s) as failures, want %d", len(fail), tt.wantFail)
			}
			if tt.wantNamed != "" {
				if len(fail) == 0 {
					t.Fatalf("triage kept no failure, so nothing names %q", tt.wantNamed)
				}
				if joined := failureList(fail); !strings.Contains(joined, tt.wantNamed) {
					t.Fatalf("the kept failures are %q, want them to name %q", joined, tt.wantNamed)
				}
			}
		})
	}
}
