package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// recordingAuthBroadcaster records BroadcastMemberBan calls so tests can
// assert self-service account deletion fans out the same event the admin
// ban path does.
type recordingAuthBroadcaster struct {
	bannedIDs []int64
}

func (r *recordingAuthBroadcaster) BroadcastMemberBan(userID int64) {
	r.bannedIDs = append(r.bannedIDs, userID)
}

// Self-service account deletion left DELETE /api/v1/auth/account with no way
// to notify other connected clients: DeleteAccount anonymises and bans the
// row exactly like the admin ban path does, but only the admin path
// broadcast an event. Every other connected client kept the deleted user's
// pre-deletion username in its member list until it reconnected (v068).
func TestDeleteAccount_BroadcastsMemberBan(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	broadcaster := &recordingAuthBroadcaster{}

	r := chi.NewRouter()
	api.MountAuthRoutes(r, service.NewAuthService(database, limiter, testTOTPKey, broadcaster), api.AuthMiddleware(database), limiter, nil)

	hash, _ := auth.HashPassword("correctPass1")
	uid, _ := database.CreateUser(context.Background(), "deletebroadcast", hash, 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := deleteJSONWithToken(t, r, "/api/v1/auth/account", token, map[string]string{
		"password": "correctPass1",
	})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DeleteAccount status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	if len(broadcaster.bannedIDs) != 1 || broadcaster.bannedIDs[0] != uid {
		t.Fatalf("BroadcastMemberBan calls = %v, want exactly [%d]", broadcaster.bannedIDs, uid)
	}
}

// A nil broadcaster (the shape every test mount uses) must keep working
// exactly as before: no event, no panic.
func TestDeleteAccount_NoBroadcasterOmitted(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()

	r := chi.NewRouter()
	api.MountAuthRoutes(r, service.NewAuthService(database, limiter, testTOTPKey, nil), api.AuthMiddleware(database), limiter, nil)

	hash, _ := auth.HashPassword("correctPass1")
	uid, _ := database.CreateUser(context.Background(), "deletenobroadcast", hash, 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := deleteJSONWithToken(t, r, "/api/v1/auth/account", token, map[string]string{
		"password": "correctPass1",
	})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DeleteAccount status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}
