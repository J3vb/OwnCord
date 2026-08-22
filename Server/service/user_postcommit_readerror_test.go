package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
)

// OC-0297: UpdateProfile's post-commit re-read (the GetUserByID call after
// UpdateUserProfile commits) can fail for reasons that have nothing to do
// with context cancellation — SQLITE_BUSY, an I/O error, pool exhaustion —
// and UpdateProfile currently reports ErrInternal in that case even though
// the write already committed. handleUploadAvatar treats any UpdateProfile
// error as proof "the column never moved" and deletes the file it just
// stored, but here the column DID move: the avatar row now points at a file
// that request just deleted, permanently breaking the avatar with no
// user_update broadcast to tell anyone. handleUpdateProfile (PATCH
// /users/me) has the same exposure: it reports 500 to a client whose rename
// actually committed, and never broadcasts it.
//
// failGetUserByIDAfterStore wraps a real *db.DB and fails GetUserByID from
// its Nth call onward, regardless of the context passed in — unlike
// cancelOnCommitStore (user_postcommit_ctx_test.go), which fails only on an
// already-canceled context. This pins the read failure itself as the
// trigger, not cancellation.
type failGetUserByIDAfterStore struct {
	*db.DB
	failFromCall int // GetUserByID calls at or after this 1-indexed count fail
	calls        int
}

func (f *failGetUserByIDAfterStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	f.calls++
	if f.calls >= f.failFromCall {
		return nil, errors.New("database is locked")
	}
	return f.DB.GetUserByID(ctx, id)
}

func TestUpdateProfile_SurvivesPostCommitReReadError(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice", PasswordHash: "h"})

	// Call 1: the pre-write GetUserByID inside UpdateProfile (must succeed so
	// the merge has a base row). Call 2: the post-commit re-read — this is
	// the one that fails, simulating a transient DB error that has nothing
	// to do with request-context cancellation.
	store := &failGetUserByIDAfterStore{DB: database, failFromCall: 2}
	svc := NewUserService(store)

	avatarURL := "/api/v1/files/new-avatar-id"
	u, err := svc.UpdateProfile(context.Background(), 1, ProfilePatch{Avatar: &avatarURL})
	if err != nil {
		t.Fatalf("UpdateProfile returned %v after UpdateUserProfile committed; "+
			"the write already landed (avatar column now points at the newly "+
			"uploaded file), so this must still succeed and report the new row "+
			"— otherwise the caller (handleUploadAvatar) treats the commit as if "+
			"it never happened and deletes the file the row now points at", err)
	}
	if u == nil || u.Avatar == nil || *u.Avatar != avatarURL {
		t.Fatalf("UpdateProfile returned user %+v, want avatar %q", u, avatarURL)
	}
	// Fields UpdateUserProfile never touches must survive the merge intact.
	if u.Username != "alice" {
		t.Fatalf("UpdateProfile merged row lost username: got %q, want %q", u.Username, "alice")
	}

	// The write itself committed regardless — confirm the DB agrees.
	stored, err := database.GetUserByID(context.Background(), 1)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if stored.Avatar == nil || *stored.Avatar != avatarURL {
		t.Fatalf("stored avatar = %v, want %q", stored.Avatar, avatarURL)
	}
}
