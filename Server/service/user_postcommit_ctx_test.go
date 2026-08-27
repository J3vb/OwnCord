package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// OC-0250: UpdateProfile (and UpdateIdentityKey) commit their write, then
// re-read the row with the *request* context to build the return value that
// the caller broadcasts to every other client. If that request context is
// canceled between the commit and the re-read — the most reachable trigger
// being a client that hangs up right after the write lands — the re-read
// fails, UpdateProfile reports ErrInternal even though the write committed,
// and the caller (handleUpdateProfile) never calls broadcastUserUpdate.
// Every sibling post-commit step in this file already detaches with
// context.WithoutCancel (the audit write two lines below); the post-commit
// GetUserByID re-read must do the same.

// cancelOnCommitStore cancels an external context the instant the write it
// wraps commits, simulating a request context that the client tears down
// immediately after the database commit that satisfies it — before this
// service function's post-commit re-read runs.
type cancelOnCommitStore struct {
	Store
	cancel context.CancelFunc
}

func (c *cancelOnCommitStore) UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about *string) error {
	err := c.Store.UpdateUserProfile(ctx, userID, username, avatar, displayName, about)
	if err == nil {
		c.cancel()
	}
	return err
}

func (c *cancelOnCommitStore) UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error {
	err := c.Store.UpdateUserIdentityKey(ctx, id, key)
	if err == nil {
		c.cancel()
	}
	return err
}

// GetUserByID mimics what a real reader-pool query does when handed an
// already-canceled context: it fails with ctx.Err() rather than returning a
// row. This is intentionally on the fake, not the real *db.DB, so the test
// pins the service's context handling rather than depending on whether
// SQLite's driver happens to notice cancellation on a given build.
func (c *cancelOnCommitStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.Store.GetUserByID(ctx, id)
}

func TestUpdateProfile_SurvivesRequestCancelAfterCommit(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice", PasswordHash: "h"})

	ctx, cancel := context.WithCancel(context.Background())
	store := &cancelOnCommitStore{Store: database}
	store.cancel = cancel
	svc := NewUserService(store)

	u, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "alice2"})
	if err != nil {
		t.Fatalf("UpdateProfile returned %v after the request ctx was canceled post-commit; "+
			"the write already committed, so this must still succeed and report the new row "+
			"(otherwise the caller never broadcasts user_update)", err)
	}
	if u == nil || u.Username != "alice2" {
		t.Fatalf("UpdateProfile returned user %+v, want username %q", u, "alice2")
	}

	// The write itself committed regardless — confirm the DB agrees, using a
	// fresh context since the original is canceled.
	stored, err := database.GetUserByID(context.Background(), 1)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if stored.Username != "alice2" {
		t.Fatalf("stored username = %q, want %q", stored.Username, "alice2")
	}
}

func TestUpdateIdentityKey_SurvivesRequestCancelAfterCommit(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice", PasswordHash: "h"})

	ctx, cancel := context.WithCancel(context.Background())
	store := &cancelOnCommitStore{Store: database}
	store.cancel = cancel
	svc := NewUserService(store)

	key := "identity-key-bytes"
	u, err := svc.UpdateIdentityKey(ctx, 1, key)
	if err != nil {
		t.Fatalf("UpdateIdentityKey returned %v after the request ctx was canceled post-commit; "+
			"the write already committed, so this must still succeed and report the new row", err)
	}
	if u == nil || u.IdentityPublicKey == nil || *u.IdentityPublicKey != key {
		t.Fatalf("UpdateIdentityKey returned user %+v, want identity key %q", u, key)
	}
}
