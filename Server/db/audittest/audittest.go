// Package audittest captures audit entries through a fake db.AuditStore so a
// test can assert which actions a mutation emitted and what its detail
// carried (B2-6). Install swaps the DB's audit path for an in-memory writer
// for the test's lifetime; every db.WriteAudit routed through that *DB —
// from api, admin, service or ws — lands in the recorder.
package audittest

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Recorder is a db.AuditStore that keeps every persisted entry in memory.
type Recorder struct {
	mu      sync.Mutex
	entries []db.AuditEntry
}

// Install routes every audit write through d into a fresh Recorder until the
// test ends. Call it before the mutation under test, after the fixture is
// seeded (seeding may legitimately write audits you do not want to assert).
func Install(t testing.TB, d *db.DB) *Recorder {
	t.Helper()
	rec := &Recorder{}
	// batchSize 1: each entry flushes as soon as the runner receives it.
	w := db.NewAuditWriter(rec, 256, 1, time.Millisecond)
	w.Start(context.Background())
	d.SetAuditWriter(w)
	t.Cleanup(func() {
		d.SetAuditWriter(nil)
		w.Stop(context.Background())
	})
	return rec
}

// PersistAudits implements db.AuditStore.
func (r *Recorder) PersistAudits(_ context.Context, entries []db.AuditEntry) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, entries...)
	return len(entries), nil
}

// Entries returns a snapshot of everything recorded so far.
func (r *Recorder) Entries() []db.AuditEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]db.AuditEntry(nil), r.entries...)
}

// Wait returns the first recorded entry with the given action, polling until
// the asynchronous writer has flushed it. It fails the test after five
// seconds, listing the actions that did arrive.
func (r *Recorder) Wait(t testing.TB, action string) db.AuditEntry {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var got []string
		entries := r.Entries()
		for i := range entries {
			e := &entries[i]
			if e.Action == action {
				return *e
			}
			got = append(got, e.Action)
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %q audit entry recorded; recorded actions: %v", action, got)
			return db.AuditEntry{}
		}
		time.Sleep(time.Millisecond)
	}
}

// detailDenylist is the shape half of the B2-6 denylist: patterns that a
// safe detail string never contains regardless of the fixture's values.
var detailDenylist = []*regexp.Regexp{
	regexp.MustCompile(`\$2[aby]\$\d\d\$`), // bcrypt hash
	regexp.MustCompile(`\$argon2`),         // argon2 hash
	// key=value / key: value leaks of a credential field.
	regexp.MustCompile(`(?i)\b(password|passwd|token|secret|recovery[_ ]?codes?|totp)\s*[:=]\s*\S`),
	regexp.MustCompile(`(?i)^otpauth://`),
	regexp.MustCompile(`(?i)\bBearer\s+\S`),
}

// AssertSafeDetails fails the test if any recorded detail matches the shape
// denylist or contains one of the fixture's known secrets — the raw tokens,
// passwords and hashes, TOTP secrets, invite codes and message bodies the
// calling table used. Fix a hit at the audit call site, never by widening
// this list's exceptions.
func AssertSafeDetails(t testing.TB, entries []db.AuditEntry, secrets ...string) {
	t.Helper()
	for i := range entries {
		e := &entries[i]
		for _, re := range detailDenylist {
			if re.MatchString(e.Detail) {
				t.Errorf("audit %q detail matches denylist %q: %q", e.Action, re, e.Detail)
			}
		}
		for _, s := range secrets {
			if s == "" {
				continue
			}
			if strings.Contains(e.Detail, s) {
				t.Errorf("audit %q detail carries a fixture secret: %q", e.Action, e.Detail)
			}
		}
	}
}
