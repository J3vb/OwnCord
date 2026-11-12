package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// DELETE /api/v1/users/me/avatar (WP 3C-7a).

func buildAvatarDeleteRouter(database *db.DB, store *storage.Storage, spy *userUpdateSpy) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountProfileRoutes(r, svc, store, limiter, nil, spy, nil)
	api.MountUploadRoutes(r, service.NewSessionService(database), store, limiter, nil, svc.Uploads)
	return r
}

func doDeleteAvatar(router http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/avatar", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := serveLocal(router, req)
	return rr
}

func TestDeleteAvatar_ClearsAndBroadcastsNull(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	spy := &userUpdateSpy{}
	router := buildAvatarDeleteRouter(database, store, spy)
	ownerToken := uploadCreateToken(t, database, "del_owner", 4)
	peerToken := uploadCreateToken(t, database, "del_peer", 4)

	up := doAvatarUpload(t, router, ownerToken, "me.png", makePNGBytes(t, 32, 32))
	requireStatus(t, up, http.StatusCreated)
	resp := decodeBody[map[string]any](t, up)
	id, _ := resp["id"].(string)
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusOK {
		t.Fatalf("peer fetch before delete = %d, want 200", got.Code)
	}
	spy.got = nil

	rr := doDeleteAvatar(router, ownerToken)
	requireStatus(t, rr, http.StatusOK)
	body := decodeBody[map[string]any](t, rr)
	if body["username"] != "del_owner" || body["avatar"] != nil {
		t.Errorf("response = %v, want username del_owner and no avatar key", body)
	}
	u, err := database.GetUserByUsername(context.Background(), "del_owner")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.Avatar != nil {
		t.Errorf("stored avatar = %q, want NULL", *u.Avatar)
	}
	if len(spy.got) != 1 || spy.got[0].Avatar != nil || spy.got[0].UserID != u.ID {
		t.Fatalf("broadcasts = %+v, want one user_update with avatar null", spy.got)
	}
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch after delete = %d, want 403", got.Code)
	}
}

// A rename that landed on another device after this request authenticated
// must survive: the route sends no username snapshot.
func TestDeleteAvatar_KeepsConcurrentRename(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildAvatarDeleteRouter(database, nil, &userUpdateSpy{})
	token := uploadCreateToken(t, database, "old_name", 4)
	u, err := database.GetUserByUsername(context.Background(), "old_name")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	av := "https://example.com/a.png"
	if err := database.UpdateUserProfile(context.Background(), u.ID, "new_name", &av, nil, nil, nil, nil); err != nil {
		t.Fatalf("rename: %v", err)
	}

	rr := doDeleteAvatar(router, token)
	requireStatus(t, rr, http.StatusOK)
	after, _ := database.GetUserByID(context.Background(), u.ID)
	if after.Username != "new_name" {
		t.Errorf("username = %q, want new_name kept", after.Username)
	}
	if after.Avatar != nil {
		t.Errorf("avatar = %q, want cleared", *after.Avatar)
	}
}

func TestDeleteAvatar_IdempotentWithoutAvatar(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildAvatarDeleteRouter(database, nil, &userUpdateSpy{})
	token := uploadCreateToken(t, database, "no_avatar", 4)
	for i := range 2 {
		if rr := doDeleteAvatar(router, token); rr.Code != http.StatusOK {
			t.Fatalf("call %d status = %d, want 200; body = %s", i, rr.Code, rr.Body.String())
		}
	}
	if rr := doDeleteAvatar(router, ""); rr.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated status = %d, want 401", rr.Code)
	}
}
