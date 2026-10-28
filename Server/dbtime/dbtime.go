// Package dbtime names the two text layouts the database stores timestamps
// in, and reads a value written in either.
//
// SQLite has no date type: a timestamp is TEXT, and a comparison against
// datetime('now') or another column is byte by byte. 'T' (0x54) sorts after
// ' ' (0x20), so a value in ISOLayout compared with one in SQLiteLayout reads
// as later than any time on the same day. A column written by SQL DEFAULTs or
// datetime('now') holds SQLiteLayout, and a Go-side value compared with it
// must use the same layout; the expiry columns written from Go hold ISOLayout,
// and their SQL compares against strftime('%Y-%m-%dT%H:%M:%SZ', 'now').
//
// MX-13: these layouts were typed by hand in 24 places under 8 names. The
// db-time-layouts invariant (Server/invariants) keeps them here.
package dbtime

import "time"

// SQLiteLayout is the text SQLite's datetime('now') writes: UTC, second
// precision, a space between date and time, no zone suffix.
const SQLiteLayout = "2006-01-02 15:04:05"

// ISOLayout is ISO-8601 UTC with a 'T' and a 'Z', the text
// strftime('%Y-%m-%dT%H:%M:%SZ', ...) writes.
const ISOLayout = "2006-01-02T15:04:05Z"

// Parse reads s in SQLiteLayout or ISOLayout as a UTC instant, reporting
// ok=false when it is in neither. Callers decide what an unreadable value
// means (a ban stays in force, a session counts as expired).
func Parse(s string) (t time.Time, ok bool) {
	for _, layout := range [...]string{SQLiteLayout, ISOLayout} {
		if parsed, err := time.Parse(layout, s); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}
