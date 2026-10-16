package service

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseSearch_TextOnlyUnchanged(t *testing.T) {
	for _, q := range []string{"hello world", "  spaced   out ", "http://x 12:30 note:x", "a\"b c", "has:link"} {
		p, err := ParseSearch(q, "")
		if err != nil {
			t.Fatalf("ParseSearch(%q): %v", q, err)
		}
		if p.Text != q || p.HasFilters {
			t.Errorf("ParseSearch(%q) = text %q filters %v, want the query untouched", q, p.Text, p.HasFilters)
		}
	}
}

func TestParseSearch_KeysCaseInsensitive(t *testing.T) {
	p, err := ParseSearch("FROM:Bob In:General word", "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.From, []string{"Bob"}) || !slices.Equal(p.In, []string{"General"}) || p.Text != "word" {
		t.Errorf("got %+v", p)
	}
}

func TestParseSearch_QuotedValue(t *testing.T) {
	p, err := ParseSearch(`from:"ann lee" in:"dev chat" hi`, "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.From, []string{"ann lee"}) || !slices.Equal(p.In, []string{"dev chat"}) || p.Text != "hi" {
		t.Errorf("got %+v", p)
	}
}

func TestParseSearch_UnterminatedQuoteRunsToEnd(t *testing.T) {
	p, err := ParseSearch(`hi from:"ann lee  and more`, "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.From, []string{"ann lee  and more"}) || p.Text != "hi" {
		t.Errorf("got %+v", p)
	}
}

func TestParseSearch_UnknownKeyStaysText(t *testing.T) {
	p, err := ParseSearch("http://x 12:30 note:x has:x mentions:bob pinned:true from:bob", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Text != "http://x 12:30 note:x has:x mentions:bob pinned:true" || !slices.Equal(p.From, []string{"bob"}) {
		t.Errorf("got %+v", p)
	}
}

func TestParseSearch_EmptyValueDropped(t *testing.T) {
	for _, q := range []string{"from: word", `from:"" word`, "from:@ word", "in:# word"} {
		p, err := ParseSearch(q, "")
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if p.Text != "word" || p.HasFilters || len(p.From) != 0 || len(p.In) != 0 {
			t.Errorf("%q: got %+v, want only text", q, p)
		}
	}
}

func TestParseSearch_LeadingAtAndHashTrimmed(t *testing.T) {
	p, err := ParseSearch("from:@bob in:#general", "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.From, []string{"bob"}) || !slices.Equal(p.In, []string{"general"}) || p.Text != "" {
		t.Errorf("got %+v", p)
	}
}

func TestParseSearch_DateSemantics(t *testing.T) {
	tests := []struct {
		q, after, before string
		empty            bool
	}{
		{"before:2026-03-10", "", "2026-03-10 00:00:00", false},
		{"after:2026-03-10", "2026-03-11 00:00:00", "", false},
		{"during:2026-03-10", "2026-03-10 00:00:00", "2026-03-11 00:00:00", false},
		{"after:2026-03-01 after:2026-03-05 before:2026-03-20 before:2026-03-15", "2026-03-06 00:00:00", "2026-03-15 00:00:00", false},
		{"after:2026-03-10 before:2026-03-11", "2026-03-11 00:00:00", "2026-03-11 00:00:00", true},
		{"during:2026-03-10 during:2026-03-12", "2026-03-12 00:00:00", "2026-03-11 00:00:00", true},
	}
	for _, tc := range tests {
		p, err := ParseSearch(tc.q, "")
		if err != nil {
			t.Fatalf("%q: %v", tc.q, err)
		}
		if p.AfterTS != tc.after || p.BeforeTS != tc.before || p.EmptyRange != tc.empty {
			t.Errorf("%q: got after=%q before=%q empty=%v", tc.q, p.AfterTS, p.BeforeTS, p.EmptyRange)
		}
	}
}

func TestParseSearch_TZ(t *testing.T) {
	// Amsterdam is UTC+1 in winter, UTC+2 in summer.
	p, err := ParseSearch("during:2026-01-15", "Europe/Amsterdam")
	if err != nil {
		t.Fatal(err)
	}
	if p.AfterTS != "2026-01-14 23:00:00" || p.BeforeTS != "2026-01-15 23:00:00" {
		t.Errorf("winter: got %q..%q", p.AfterTS, p.BeforeTS)
	}
	p, err = ParseSearch("during:2026-07-15", "Europe/Amsterdam")
	if err != nil {
		t.Fatal(err)
	}
	if p.AfterTS != "2026-07-14 22:00:00" || p.BeforeTS != "2026-07-15 22:00:00" {
		t.Errorf("summer: got %q..%q", p.AfterTS, p.BeforeTS)
	}
	// A DST change day is 23 hours long, handled per bound.
	p, err = ParseSearch("during:2026-03-29", "Europe/Amsterdam")
	if err != nil {
		t.Fatal(err)
	}
	if p.AfterTS != "2026-03-28 23:00:00" || p.BeforeTS != "2026-03-29 22:00:00" {
		t.Errorf("dst day: got %q..%q", p.AfterTS, p.BeforeTS)
	}
}

func TestParseSearch_BadInputIsBadRequest(t *testing.T) {
	tests := []struct{ q, tz, mention string }{
		{"before:2026-02-30", "", "before:"},
		{"after:yesterday", "", "after:"},
		{"during:2026-1-5", "", "during:"},
		{"before:0000-01-01", "", "before:"},
		{"hello", "Mars/Olympus", "tz"},
		{"hello", "Local", "tz"},
		{"hello", strings.Repeat("x", 100), "tz"},
	}
	for _, tc := range tests {
		_, err := ParseSearch(tc.q, tc.tz)
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("ParseSearch(%q, %q) err = %v, want ErrBadRequest", tc.q, tc.tz, err)
			continue
		}
		if !strings.Contains(err.Error(), tc.mention) {
			t.Errorf("error %q does not name %q", err, tc.mention)
		}
	}
}

func TestParseSearch_Limits(t *testing.T) {
	ok := strings.Repeat("in:a ", 10) + strings.Repeat("from:b ", 10) + strings.Repeat("before:2026-01-01 ", 5)
	if _, err := ParseSearch(ok, ""); err != nil {
		t.Fatalf("25 tokens: %v", err)
	}
	if _, err := ParseSearch(ok+"before:2026-01-02", ""); !errors.Is(err, ErrBadRequest) {
		t.Errorf("26 tokens: err = %v, want ErrBadRequest", err)
	}
	if _, err := ParseSearch(strings.Repeat("from:b ", 11), ""); !errors.Is(err, ErrBadRequest) {
		t.Errorf("11 from values: err = %v, want ErrBadRequest", err)
	}
	if _, err := ParseSearch(strings.Repeat("in:b ", 11), ""); !errors.Is(err, ErrBadRequest) {
		t.Errorf("11 in values: err = %v, want ErrBadRequest", err)
	}
}

func FuzzParseSearch(f *testing.F) {
	for _, s := range []string{"", "from:bob hi", `from:"a b" in:#x`, "during:2026-01-01", `from:"`, "in:", "FROM: x", "a:b:c", "before:9999-12-31 after:0001-01-01"} {
		f.Add(s, "UTC")
	}
	f.Fuzz(func(t *testing.T, q, tz string) {
		p, err := ParseSearch(q, tz)
		if err != nil {
			if !errors.Is(err, ErrBadRequest) {
				t.Fatalf("non-BadRequest error: %v", err)
			}
			return
		}
		if !utf8.ValidString(q) {
			return
		}
		// Every non-space rune of q must land in the text or a filter value,
		// or be the key/colon/quote syntax of a filter token.
		if !p.HasFilters && p.Text != q && !strings.Contains(q, ":") {
			t.Fatalf("filterless query changed: %q -> %q", q, p.Text)
		}
		for w := range strings.FieldsSeq(p.Text) {
			if !strings.Contains(q, w) {
				t.Fatalf("text word %q is not from %q", w, q)
			}
		}
		for _, v := range append(slices.Clone(p.From), p.In...) {
			if !strings.Contains(q, v) {
				t.Fatalf("filter value %q is not from %q", v, q)
			}
		}
		if p.AfterTS != "" && len(p.AfterTS) != len("2006-01-02 15:04:05") {
			t.Fatalf("bad AfterTS %q", p.AfterTS)
		}
		if p.BeforeTS != "" && len(p.BeforeTS) != len("2006-01-02 15:04:05") {
			t.Fatalf("bad BeforeTS %q", p.BeforeTS)
		}
		for _, v := range append(slices.Clone(p.From), p.In...) {
			if v == "" {
				t.Fatalf("empty filter value kept")
			}
		}
	})
}
