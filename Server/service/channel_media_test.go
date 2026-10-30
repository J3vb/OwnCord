package service

import (
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestMediaCursor_RoundTrip(t *testing.T) {
	c := db.MediaCursor{MessageID: 42, AttachmentID: "3f2a-9B"}
	got, err := ParseMediaCursor(FormatMediaCursor(c))
	if err != nil || got != c {
		t.Fatalf("round trip = %+v, %v; want %+v", got, err, c)
	}
	for _, raw := range []string{"", "42", "42_", "0_a", "-1_a", "x_a", "42_a b", "42_a'--", "42_a_b"} {
		if _, err := ParseMediaCursor(raw); !errors.Is(err, ErrBadRequest) {
			t.Errorf("ParseMediaCursor(%q) err = %v, want ErrBadRequest", raw, err)
		}
	}
}

func TestFoldMediaMonths_LocalMonthsNewestFirst(t *testing.T) {
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skipf("tzdata: %v", err)
	}
	buckets := []db.MediaBucket{
		{Start: time.Date(2026, 1, 31, 18, 15, 0, 0, time.UTC), Count: 2}, // 23:45 local, still January
		{Start: time.Date(2026, 1, 31, 18, 30, 0, 0, time.UTC), Count: 3}, // 00:00 local, February
		{Start: time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC), Count: 1},
	}
	got := foldMediaMonths(buckets, kolkata)
	want := []MediaMonth{{"2026-02", 3}, {"2026-01", 2}, {"2025-12", 1}}
	if len(got) != len(want) {
		t.Fatalf("months = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("months = %v, want %v", got, want)
			break
		}
	}
}

func TestParseMediaMonth_Bounds(t *testing.T) {
	start, next, err := parseMediaMonth("2026-12", time.UTC)
	if err != nil || !start.Equal(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)) || !next.Equal(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("2026-12 = %v %v %v", start, next, err)
	}
	for _, bad := range []string{"2026-13", "2026-1", "26-01", "0000-01", "9999-01", "2026-01-01"} {
		if _, _, err := parseMediaMonth(bad, time.UTC); !errors.Is(err, ErrBadRequest) {
			t.Errorf("parseMediaMonth(%q) err = %v", bad, err)
		}
	}
}
