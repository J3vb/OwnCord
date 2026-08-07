package api_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// identityKeyFailStore wraps a real *db.DB and fails only
// UpdateUserIdentityKey, simulating the transient DB error that can strike
// after handleUpdateProfile's profile write has already committed.
type identityKeyFailStore struct {
	*db.DB
}

func (s *identityKeyFailStore) UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error {
	return errors.New("simulated identity key write failure")
}

// A follow-on identity-key failure must not swallow the profile write that
// already committed: the response reports failure, but every other
// connected client still needs the committed username/avatar change, or it
// silently disappears until their next ready (v100).
func TestUpdateProfile_IdentityKeyFailureStillBroadcastsCommittedProfile(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	failingStore := &identityKeyFailStore{database}
	svc := service.New(failingStore, limiter)
	spy := &userUpdateSpy{}

	r := chi.NewRouter()
	api.MountProfileRoutes(r, database, svc, nil, limiter, nil, spy)

	token := profileCreateToken(t, database, "identitykeyuser", 4)

	rr := patchJSON(t, r, "/api/v1/users/me", token, map[string]any{
		"username":            "renamedidentitykeyuser",
		"identity_public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rr.Code, rr.Body.String())
	}

	// The username write committed even though the request reports failure.
	user, err := database.GetUserByUsername(context.Background(), "renamedidentitykeyuser")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if user == nil {
		t.Fatal("expected the username change to have committed despite the identity-key failure")
	}

	if len(spy.got) != 1 {
		t.Fatalf("BroadcastUserUpdate calls = %d, want 1 (the committed profile, even though the request failed)", len(spy.got))
	}
	got := spy.got[0]
	if got.Username != "renamedidentitykeyuser" {
		t.Errorf("broadcast username = %q, want the committed rename", got.Username)
	}
	if got.IdentityPublicKey != nil {
		t.Errorf("broadcast identity key = %v, want nil (that half never committed)", *got.IdentityPublicKey)
	}
}
