package api_test

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// seenCountingStore counts the acknowledgement writes GET sessions makes.
type seenCountingStore struct {
	*db.DB
	marks atomic.Int64
}

func (s *seenCountingStore) MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error) {
	s.marks.Add(1)
	return s.DB.MarkSessionsSeen(ctx, userID, exceptSessionID)
}

// Listing sessions acknowledges unseen logins, but only when the list holds
// one other than the caller's own: a listing with nothing new stays a pure
// read and never takes the writer.
func TestListSessions_WritesOnlyWhenAnotherLoginIsUnseen(t *testing.T) {
	database := newAuthTestDB(t)
	store := &seenCountingStore{DB: database}
	limiter := auth.NewRateLimiter()
	r := chi.NewRouter()
	api.MountProfileRoutes(r, service.New(store, limiter), nil, limiter, nil, nil, nil)

	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "seencount", mustHash(t), 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	login := func(device string) string {
		t.Helper()
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), device, "10.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		return token
	}
	list := func(token string) {
		t.Helper()
		if rr := getWithToken(t, r, "/api/v1/users/me/sessions", token); rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
		}
	}

	laptop := login("Laptop")
	// Only the caller's own unseen row: nothing to acknowledge.
	list(laptop)
	if got := store.marks.Load(); got != 0 {
		t.Fatalf("marks after listing only its own row = %d, want 0", got)
	}

	login("Phone")
	// The phone's login is new to the laptop: one acknowledgement.
	list(laptop)
	if got := store.marks.Load(); got != 1 {
		t.Fatalf("marks after a new login = %d, want 1", got)
	}

	// Nothing new since: the repeat listing is a pure read.
	list(laptop)
	list(laptop)
	if got := store.marks.Load(); got != 1 {
		t.Fatalf("marks after repeat listings = %d, want still 1", got)
	}
}
