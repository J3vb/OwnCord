package admin

import (
	"bytes"
	"net/http/httptest"
	"testing"
)

type countingFlusher struct{ flushes int }

func (f *countingFlusher) Flush() { f.flushes++ }

func TestWriteBackfill_ChecksThePrincipalOncePerChunk(t *testing.T) {
	backfill := fillRing(2*backfillChunk+1, "2026-10-30T10:00:00Z").Snapshot()
	rec := httptest.NewRecorder()
	flusher := &countingFlusher{}
	checks := 0

	ok := writeBackfill(rec, flusher, backfill, func() bool { checks++; return true })

	if !ok {
		t.Fatal("writeBackfill reported a lost principal that never lost access")
	}
	if checks != 3 {
		t.Fatalf("principal checks = %d, want 3 (one per chunk of %d)", checks, backfillChunk)
	}
	if flusher.flushes != 3 {
		t.Fatalf("flushes = %d, want 3 so each chunk reaches the browser as soon as it is written", flusher.flushes)
	}
	if got := bytes.Count(rec.Body.Bytes(), []byte("data: ")); got != len(backfill) {
		t.Fatalf("frames = %d, want every one of the %d entries", got, len(backfill))
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"msg":"line 1000"`)) {
		t.Fatal("the last chunk's entry is missing from the stream")
	}
}

func TestWriteBackfill_EmptyRingNeedsNoCheck(t *testing.T) {
	rec := httptest.NewRecorder()
	checks := 0
	if !writeBackfill(rec, &countingFlusher{}, nil, func() bool { checks++; return false }) {
		t.Fatal("an empty backfill must not end the stream")
	}
	if checks != 0 || rec.Body.Len() != 0 {
		t.Fatalf("empty backfill made %d checks and wrote %q", checks, rec.Body.String())
	}
}
