// Package dbtime names the two text layouts the database stores timestamps in,
// and reads either.
//
// SQLite timestamps are TEXT compared byte by byte, and 'T' (0x54) sorts after
// ' ' (0x20), so an ISOLayout value compared with a SQLiteLayout one reads as
// later than any time that day. Columns written by SQL DEFAULTs or datetime('now')
// hold SQLiteLayout, and Go-side values compared with them must match; the expiry
// columns written from Go hold ISOLayout. The db-time-layouts invariant keeps the layouts here.
package dbtime

import "time"

// SQLiteLayout is what datetime('now') writes: UTC, seconds, a space, no zone suffix.
const SQLiteLayout = "2006-01-02 15:04:05"

// ISOLayout is ISO-8601 UTC with 'T' and 'Z', as strftime('%Y-%m-%dT%H:%M:%SZ', ...) writes.
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
