package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// The write-through branches that only log: a persister that reads fine but
// cannot write or delete must leave the stores usable and never panic. These
// are the paths a database outage mid-login walks (data-lifecycle.md, O8).

type flakyPersister struct {
	challenge struct {
		userID    int64
		device    string
		ip        string
		failures  int
		expiresAt time.Time
		present   bool
	}
	pending struct {
		sealed    string
		expiresAt time.Time
		present   bool
	}
	failWrites bool
	deletes    int
}

var errFlaky = errors.New("flaky persister")

func (p *flakyPersister) UpsertPartialAuth(_ context.Context, _ string, userID int64, device, ip string, failures int, expiresAt time.Time) error {
	if p.failWrites {
		return errFlaky
	}
	p.challenge.userID, p.challenge.device, p.challenge.ip = userID, device, ip
	p.challenge.failures, p.challenge.expiresAt, p.challenge.present = failures, expiresAt, true
	return nil
}

func (p *flakyPersister) GetPartialAuth(context.Context, string) (int64, string, string, int, time.Time, bool, error) {
	c := p.challenge
	return c.userID, c.device, c.ip, c.failures, c.expiresAt, c.present, nil
}

func (p *flakyPersister) DeletePartialAuth(context.Context, string) (bool, error) {
	p.deletes++
	if p.failWrites {
		return false, errFlaky
	}
	was := p.challenge.present
	p.challenge.present = false
	return was, nil
}

func (p *flakyPersister) UpsertPendingTOTP(_ context.Context, _ int64, sealed string, expiresAt time.Time) error {
	if p.failWrites {
		return errFlaky
	}
	p.pending.sealed, p.pending.expiresAt, p.pending.present = sealed, expiresAt, true
	return nil
}

func (p *flakyPersister) GetPendingTOTP(context.Context, int64) (string, time.Time, bool, error) {
	return p.pending.sealed, p.pending.expiresAt, p.pending.present, nil
}

func (p *flakyPersister) DeletePendingTOTP(context.Context, int64) error {
	p.deletes++
	if p.failWrites {
		return errFlaky
	}
	p.pending.present = false
	return nil
}

func (p *flakyPersister) InsertUsedTOTPCode(context.Context, int64, string, time.Time) (bool, error) {
	if p.failWrites {
		return false, errFlaky
	}
	return true, nil
}

func (p *flakyPersister) DeleteUsedTOTPCode(context.Context, int64, string) error {
	p.deletes++
	if p.failWrites {
		return errFlaky
	}
	return nil
}

func TestPartialAuthStore_WriteFailuresAfterIssueAreLoggedNotFatal(t *testing.T) {
	ctx := context.Background()
	p := &flakyPersister{}
	store := auth.NewPartialAuthStore(time.Minute).WithPersister(p)
	token, err := store.Issue(ctx, 7, "d", "ip")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	p.failWrites = true

	// A failure count that cannot be persisted still counts the attempt as
	// alive; an exhausted challenge that cannot be deleted still reads as
	// exhausted to the caller.
	if !store.RegisterFailure(ctx, token, 5) {
		t.Fatal("RegisterFailure reported the challenge dead on a persist failure")
	}
	if store.RegisterFailure(ctx, token, 1) {
		t.Fatal("RegisterFailure kept an exhausted challenge alive because the delete failed")
	}

	// Consume fails closed when the delete cannot be recorded.
	if _, ok := store.Consume(ctx, token); ok {
		t.Fatal("Consume claimed a challenge whose delete failed")
	}

	// Restore with a failing persister does not panic and leaves the
	// persister's copy as it was.
	store.Restore(ctx, token, auth.PartialAuthChallenge{UserID: 7, ExpiresAt: time.Now().Add(time.Minute)})
	if p.deletes < 2 {
		t.Fatalf("expected the delete attempts to reach the persister, got %d", p.deletes)
	}
}

func TestPendingTOTPStore_WriteFailuresAndBadKey(t *testing.T) {
	ctx := context.Background()
	key := testAESKey()
	p := &flakyPersister{}
	store := auth.NewPendingTOTPStore(time.Minute).WithPersister(p, key)
	if err := store.Put(ctx, 1, "SECRET"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// A different process with a different key cannot unseal the row.
	other := auth.NewPendingTOTPStore(time.Minute).WithPersister(p, append([]byte{}, make([]byte, 32)...))
	if _, ok := other.Lookup(ctx, 1); ok {
		t.Fatal("a pending secret was unsealed with the wrong key")
	}

	// A delete that fails is logged; the caller is not blocked.
	p.failWrites = true
	store.Delete(ctx, 1)
	if p.deletes != 1 {
		t.Fatalf("delete attempts = %d, want 1", p.deletes)
	}

	// Sealing with an unusable key is an error before anything is written.
	broken := auth.NewPendingTOTPStore(time.Minute).WithPersister(&flakyPersister{}, []byte("short"))
	if err := broken.Put(ctx, 2, "SECRET"); err == nil {
		t.Fatal("Put sealed a secret with an invalid key")
	}
}

func TestUsedTOTPCodeStore_UnmarkFailureIsLogged(t *testing.T) {
	ctx := context.Background()
	p := &flakyPersister{}
	store := auth.NewUsedTOTPCodeStore().WithPersister(p)
	if !store.MarkUsed(ctx, 1, "123456") {
		t.Fatal("MarkUsed refused a fresh code")
	}
	p.failWrites = true
	store.Unmark(ctx, 1, "123456")
	if p.deletes != 1 {
		t.Fatalf("delete attempts = %d, want 1", p.deletes)
	}
}
