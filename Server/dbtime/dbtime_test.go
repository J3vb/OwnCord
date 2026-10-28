package dbtime

import (
	"testing"
	"time"
)

func TestLayoutsAreTheStoredText(t *testing.T) {
	at := time.Date(2026, 10, 28, 9, 5, 7, 999_000_000, time.UTC)
	if got, want := at.Format(SQLiteLayout), "2026-10-28 09:05:07"; got != want {
		t.Errorf("SQLiteLayout renders %q, want %q", got, want)
	}
	if got, want := at.Format(ISOLayout), "2026-10-28T09:05:07Z"; got != want {
		t.Errorf("ISOLayout renders %q, want %q", got, want)
	}
}

func TestParse(t *testing.T) {
	want := time.Date(2026, 10, 28, 9, 5, 7, 0, time.UTC)
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"2026-10-28 09:05:07", true},
		{"2026-10-28T09:05:07Z", true},
		{"", false},
		{"never", false},
		{"2026-10-28", false},
		{"2026-10-28T09:05:07+02:00", false},
		{"2026-10-28 09:05:07Z", false},
	} {
		got, ok := Parse(tc.in)
		if ok != tc.ok {
			t.Errorf("Parse(%q) ok = %v, want %v", tc.in, ok, tc.ok)
			continue
		}
		if ok && !got.Equal(want) {
			t.Errorf("Parse(%q) = %v, want %v", tc.in, got, want)
		}
		if !ok && !got.IsZero() {
			t.Errorf("Parse(%q) = %v on failure, want the zero time", tc.in, got)
		}
	}
}

func TestParse_BothLayoutsAgree(t *testing.T) {
	at := time.Now().UTC().Truncate(time.Second)
	space, ok1 := Parse(at.Format(SQLiteLayout))
	iso, ok2 := Parse(at.Format(ISOLayout))
	if !ok1 || !ok2 || !space.Equal(iso) || !space.Equal(at) {
		t.Fatalf("Parse: space %v (%v), iso %v (%v), want both %v", space, ok1, iso, ok2, at)
	}
}
