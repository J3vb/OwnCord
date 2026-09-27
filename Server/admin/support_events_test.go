package admin

// SRE-03 (S half): events.json held the last 200 records at ANY level, so a
// burst of INFO/DEBUG noise pushed the Warn-and-above records an operator needs
// out of the bundle. It now keeps the last N WARN-and-above records (with the
// most recent INFO/DEBUG still present under a tighter cap), so a failure
// survives noise.

import (
	"strings"
	"testing"
	"time"
)

// ts returns a distinct RFC3339Nano timestamp n milliseconds from a base.
func ts(n int) string {
	return time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Millisecond).Format(time.RFC3339Nano)
}

// TestSupportEvents_PrefersWarnAndAboveUnderNoise pins the fix: when the ring
// holds far more than the cap of INFO/DEBUG records, the WARN/ERROR records
// still appear in the bundle.
func TestSupportEvents_PrefersWarnAndAboveUnderNoise(t *testing.T) {
	rb := NewRingBuffer(2000)
	// 1000 INFO records ...
	for i := range 1000 {
		rb.Write(LogEntry{Timestamp: ts(i), Level: "INFO", Message: "http request"})
	}
	// ... then two WARN/ERROR records the old 200-tail truncation dropped.
	rb.Write(LogEntry{Timestamp: ts(1001), Level: "WARN", Message: "backup maintenance failed"})
	rb.Write(LogEntry{Timestamp: ts(1002), Level: "ERROR", Message: "livekit: process exited unexpectedly"})

	events := supportEvents(rb)

	var sawWarn, sawError bool
	for _, e := range events {
		if e.Event == "backup_maintenance_failed" && e.Level == "WARN" {
			sawWarn = true
		}
		if e.Event == "livekit_process_exited" && e.Level == "ERROR" {
			sawError = true
		}
	}
	if !sawWarn || !sawError {
		t.Fatalf("Warn/Error records were pushed out of the bundle by INFO noise (warn=%v error=%v): %+v", sawWarn, sawError, events)
	}
}

// TestSupportEvents_WarnSurvivesRingOverflow pins that an INFO burst longer
// than the whole log ring still cannot evict an earlier failure.
func TestSupportEvents_WarnSurvivesRingOverflow(t *testing.T) {
	rb := NewRingBuffer(2000)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "backup maintenance failed"})
	for i := range 2500 {
		rb.Write(LogEntry{Timestamp: ts(i + 1), Level: "INFO", Message: "http request"})
	}

	events := supportEvents(rb)

	if len(events) != supportEventsMax {
		t.Fatalf("events.json kept %d records, want %d", len(events), supportEventsMax)
	}
	if events[0].Event != "backup_maintenance_failed" || events[0].Level != "WARN" {
		t.Fatalf("WARN evicted by an INFO burst longer than the ring; first event %+v", events[0])
	}
	for i := 1; i < len(events); i++ {
		if want := ts(2500 - supportEventsMax + 1 + i); events[i].Level != "INFO" || events[i].Timestamp != want {
			t.Fatalf("event %d = %+v, want the INFO at %s", i, events[i], want)
		}
	}
}

// TestSupportEvents_CapsTotalSize pins that the timeline stays bounded even
// under a flood of WARN records, so a bundle cannot grow without limit.
func TestSupportEvents_CapsTotalSize(t *testing.T) {
	rb := NewRingBuffer(5000)
	for i := range 5000 {
		rb.Write(LogEntry{Timestamp: ts(i), Level: "WARN", Message: "backup maintenance failed"})
	}
	events := supportEvents(rb)
	if len(events) > supportEventsMax {
		t.Fatalf("events.json kept %d records, want at most %d", len(events), supportEventsMax)
	}
}

// TestSupportEvents_StillSanitizes pins that the privacy contract is unchanged:
// a free-form message is still mapped to log_event and attrs are still dropped,
// whatever the level.
func TestSupportEvents_StillSanitizes(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "ERROR", Message: "failed request token=secret", Attrs: `{"token":"secret"}`})
	events := supportEvents(rb)
	if len(events) != 1 || events[0].Event != "log_event" {
		t.Fatalf("unsanitized event: %+v", events)
	}
	for _, e := range events {
		if strings.Contains(e.Event, "secret") {
			t.Fatalf("secret leaked into the event code: %+v", e)
		}
	}
}
