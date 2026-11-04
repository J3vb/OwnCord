package api_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// identityKeyFailStore wraps a real *db.DB and fails the identity-key half of
// the profile write inside its transaction, after the profile columns were
// written, so the rollback is what keeps them unchanged.
type identityKeyFailStore struct {
	*db.DB
}

func (s *identityKeyFailStore) UpdateUserProfileAndIdentityKey(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string, _ string) error {
	tx, err := s.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `UPDATE users SET username = ? WHERE id = ?`, username, userID); err != nil {
		return err
	}
	return errors.New("simulated identity key write failure")
}

// PATCH /users/me with an identity key is all-or-nothing: when the key write
// fails, the profile change rolls back with it, the request reports the
// failure, and nothing is broadcast, so no client sees a half-saved profile.
func TestUpdateProfile_IdentityKeyFailureLeavesProfileUnchanged(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(&identityKeyFailStore{database}, limiter)
	spy := &userUpdateSpy{}

	r := chi.NewRouter()
	api.MountProfileRoutes(r, svc, nil, limiter, nil, spy, nil)
	token := profileCreateToken(t, database, "identitykeyuser", 4)

	rr := patchJSON(t, r, "/api/v1/users/me", token, map[string]any{
		"username":            "renamedidentitykeyuser",
		"identity_public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rr.Code, rr.Body.String())
	}

	if user, _ := database.GetUserByUsername(context.Background(), "renamedidentitykeyuser"); user != nil {
		t.Fatal("the username change committed even though the identity key write failed")
	}
	if user, _ := database.GetUserByUsername(context.Background(), "identitykeyuser"); user == nil || user.IdentityPublicKey != nil {
		t.Fatalf("user after the failed PATCH = %+v, want the original name and no key", user)
	}
	if len(spy.got) != 0 {
		t.Fatalf("BroadcastUserUpdate calls = %d, want 0 (nothing committed)", len(spy.got))
	}
}

// The happy path commits both halves and broadcasts the profile once, key
// included.
func TestUpdateProfile_IdentityKeyCommitsWithProfile(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	spy := &userUpdateSpy{}

	r := chi.NewRouter()
	api.MountProfileRoutes(r, svc, nil, limiter, nil, spy, nil)
	token := profileCreateToken(t, database, "identitykeyok", 4)

	const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	rr := patchJSON(t, r, "/api/v1/users/me", token, map[string]any{
		"username":            "identitykeyok2",
		"identity_public_key": key,
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	user, err := database.GetUserByUsername(context.Background(), "identitykeyok2")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v, %v", user, err)
	}
	if user.IdentityPublicKey == nil || *user.IdentityPublicKey != key {
		t.Fatalf("stored identity key = %v, want %q", user.IdentityPublicKey, key)
	}
	if len(spy.got) != 1 || spy.got[0].IdentityPublicKey == nil || *spy.got[0].IdentityPublicKey != key {
		t.Fatalf("broadcasts = %+v, want one carrying the key", spy.got)
	}
}
