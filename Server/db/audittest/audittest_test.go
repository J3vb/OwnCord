package audittest

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// failCounter records Errorf calls so the denylist can be proven to bite.
type failCounter struct {
	testing.TB
	errs int
}

func (f *failCounter) Helper()                   {}
func (f *failCounter) Errorf(string, ...any)     { f.errs++ }
func (f *failCounter) Fatalf(s string, a ...any) { f.errs++ }

// TestAssertSafeDetails_Bites proves each denylist class rejects a detail
// that carries it and that a plain detail passes — a denylist that cannot
// fail proves nothing about the corpus.
func TestAssertSafeDetails_Bites(t *testing.T) {
	bad := []db.AuditEntry{
		{Action: "a", Detail: "hash $2a$12$abcdefghijklmnopqrstuv"},
		{Action: "b", Detail: "rotated password=hunter2"},
		{Action: "c", Detail: "Token: abc"},
		{Action: "d", Detail: "otpauth://totp/x?secret=Y"},
		{Action: "e", Detail: "Bearer eyJ"},
		{Action: "f", Detail: "message body: the fixture secret"},
	}
	for _, e := range bad {
		fc := &failCounter{TB: t}
		AssertSafeDetails(fc, []db.AuditEntry{e}, "the fixture secret")
		if fc.errs == 0 {
			t.Errorf("denylist let %q through: %q", e.Action, e.Detail)
		}
	}
	fc := &failCounter{TB: t}
	AssertSafeDetails(fc, []db.AuditEntry{
		{Action: "ok", Detail: "password changed"},
		{Action: "ok", Detail: "max_uses=5 expires_in_hours=24"},
		{Action: "ok", Detail: "set overrides for role mod on #general (allow=0x1 deny=0x2)"},
	}, "the fixture secret")
	if fc.errs != 0 {
		t.Errorf("denylist rejected safe details: %d errors", fc.errs)
	}
}
