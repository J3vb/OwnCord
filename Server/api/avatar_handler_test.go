package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// Avatar upload. The interesting properties are the ones a URL-only avatar
// field never had to answer: what the server accepts as an image, where the
// bytes end up, and — the one that would otherwise be a privacy bug — who is
// allowed to fetch them back.

// buildAvatarRouter mounts the profile routes (with storage, so the upload
// route exists) and the upload routes (so the file can be fetched back)
// against one database.
func buildAvatarRouter(database *db.DB, store *storage.Storage) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountProfileRoutes(r, database, svc, store, limiter, nil, nil)
	api.MountUploadRoutes(r, service.NewSessionService(database), store, limiter, nil, svc.Uploads)
	return r
}

func doAvatarUpload(t *testing.T, router http.Handler, token, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, "file", filename, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func TestUploadAvatar_StoresAndSetsAvatarURL(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "pfp_owner", 4)

	rr := doAvatarUpload(t, router, token, "me.png", makePNGBytes(t, 64, 64))
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id, _ := resp["id"].(string)
	if id == "" {
		t.Fatal("response carried no file id")
	}
	if resp["url"] != service.AvatarFileURL(id) {
		t.Errorf("url = %v, want %q", resp["url"], service.AvatarFileURL(id))
	}
	if resp["mime"] != "image/png" {
		t.Errorf("mime = %v, want image/png", resp["mime"])
	}

	// The column must now point at the served file — that is what makes the
	// avatar both renderable and readable.
	user, err := database.GetUserByUsername(context.Background(), "pfp_owner")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if user.Avatar == nil || *user.Avatar != service.AvatarFileURL(id) {
		t.Fatalf("stored avatar = %v, want %q", user.Avatar, service.AvatarFileURL(id))
	}
}

func TestUploadAvatar_IsReadableByOtherUsersWhileInUse(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	ownerToken := uploadCreateToken(t, database, "avatar_owner", 4)
	otherToken := uploadCreateToken(t, database, "avatar_peer", 4)

	rr := doAvatarUpload(t, router, ownerToken, "me.png", makePNGBytes(t, 32, 32))
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	id, _ := resp["id"].(string)

	// An unlinked attachment is normally uploader-only. An avatar has to be
	// visible to the people who see the messages it sits beside.
	if got := doServeFile(t, router, id, otherToken, nil); got.Code != http.StatusOK {
		t.Fatalf("peer fetch status = %d, want 200; body = %s", got.Code, got.Body.String())
	}

	// Replacing the avatar revokes that: the old file goes back to being a
	// private unlinked attachment.
	rr2 := doAvatarUpload(t, router, ownerToken, "me2.png", makePNGBytes(t, 33, 33))
	if rr2.Code != http.StatusCreated {
		t.Fatalf("second upload status = %d; body = %s", rr2.Code, rr2.Body.String())
	}
	if got := doServeFile(t, router, id, otherToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch of replaced avatar = %d, want 403", got.Code)
	}
	// The uploader can still reach their own old file.
	if got := doServeFile(t, router, id, ownerToken, nil); got.Code != http.StatusOK {
		t.Errorf("uploader fetch of replaced avatar = %d, want 200", got.Code)
	}
}

func TestUploadAvatar_RejectsNonImageAndOversizedDimensions(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "avatar_bad", 4)

	// Sniffed from the bytes, never from the filename or the client's header.
	if rr := doAvatarUpload(t, router, token, "me.png", []byte("this is plain text, not a PNG")); rr.Code != http.StatusBadRequest {
		t.Errorf("text-as-png status = %d, want 400", rr.Code)
	}
	// GIF is a real image and still refused: an animated avatar in every
	// message row is a distraction the renderer cannot opt out of.
	gif := []byte("GIF89a")
	if rr := doAvatarUpload(t, router, token, "me.gif", gif); rr.Code != http.StatusBadRequest {
		t.Errorf("gif status = %d, want 400", rr.Code)
	}
	// Too many pixels for any surface that renders it.
	if rr := doAvatarUpload(t, router, token, "huge.png", makePNGBytes(t, 2000, 100)); rr.Code != http.StatusBadRequest {
		t.Errorf("oversized status = %d, want 400", rr.Code)
	}

	// None of the rejections may have moved the column.
	user, _ := database.GetUserByUsername(context.Background(), "avatar_bad")
	if user != nil && user.Avatar != nil && *user.Avatar != "" {
		t.Errorf("a rejected upload set the avatar to %q", *user.Avatar)
	}
}

func TestUploadAvatar_RequiresAuthAndAFile(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "avatar_auth", 4)

	if rr := doAvatarUpload(t, router, "", "me.png", makePNGBytes(t, 8, 8)); rr.Code != http.StatusUnauthorized {
		t.Errorf("anonymous status = %d, want 401", rr.Code)
	}
	// Right form, wrong field name.
	body, contentType := makeMultipartFile(t, "avatar", "me.png", makePNGBytes(t, 8, 8))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("wrong field status = %d, want 400", rr.Code)
	}
}

// TestUploadAvatar_StorageErrorDoesNotLeakPath pins the same contract
// upload_handler.go's safeStorageErrorMessage enforces for the plain-file
// upload route: a storage.Save failure (disk full, permission change,
// read-only mount) must never hand the client the server's absolute
// storage path. handleUploadAvatar currently forwards saveErr verbatim.
func TestUploadAvatar_StorageErrorDoesNotLeakPath(t *testing.T) {
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "avatar_leakuser", 4)

	// Remove the storage directory out from under the already-constructed
	// Storage so Save's os.Create fails — this is what a disk-full,
	// permission-change, or read-only-mount failure looks like from the
	// handler's point of view: a storage-layer error surfaces at Save time.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	rr := doAvatarUpload(t, router, token, "me.png", makePNGBytes(t, 32, 32))
	// Server-side filesystem failures are 507 (storage.ErrIO) so they are
	// distinguishable from bad uploads; the no-leak contract is unchanged.
	if rr.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	message, _ := resp["message"].(string)
	if strings.Contains(message, dir) {
		t.Fatalf("response message leaks the absolute storage path: %q", message)
	}
	if strings.ContainsAny(message, `/\`) {
		t.Fatalf("response message looks like it contains a filesystem path: %q", message)
	}
}

func TestUploadAvatar_NotMountedWithoutStorage(t *testing.T) {
	database := newUploadTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, database, service.New(database, limiter), nil, limiter, nil, nil)
	token := uploadCreateToken(t, database, "no_storage", 4)

	if rr := doAvatarUpload(t, r, token, "me.png", makePNGBytes(t, 8, 8)); rr.Code == http.StatusCreated {
		t.Error("avatar upload must not be served when there is no storage backend")
	}
}

// ─── PATCH /users/me: display name and about ─────────────────────────────────

func TestUpdateProfile_SetsDisplayNameAndAbout(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "bio_user", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username":     "bio_user",
		"display_name": "Bio User",
		"about":        "writes tests",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["display_name"] != "Bio User" {
		t.Errorf("display_name = %v", resp["display_name"])
	}
	if resp["about"] != "writes tests" {
		t.Errorf("about = %v", resp["about"])
	}

	// Omitting them leaves them alone.
	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]any{"username": "bio_user"})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	resp = map[string]any{}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["display_name"] != "Bio User" || resp["about"] != "writes tests" {
		t.Errorf("a username-only PATCH cleared fields: %v / %v", resp["display_name"], resp["about"])
	}

	// An explicit empty string clears them.
	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "bio_user", "display_name": "", "about": "",
	})
	resp = map[string]any{}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["display_name"] != nil || resp["about"] != nil {
		t.Errorf("expected cleared, got %v / %v", resp["display_name"], resp["about"])
	}
}

func TestUpdateProfile_RejectsBadDisplayName(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "dn_user", 4)

	// A right-to-left override makes a name render as something other than
	// what it says — the same spoof auth.ValidateUsername rejects.
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "dn_user", "display_name": "ada\u202egnp.exe",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("bidi-override display_name status = %d, want 400", rr.Code)
	}

	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "dn_user", "display_name": strings.Repeat("a", 33),
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("overlong display_name status = %d, want 400", rr.Code)
	}

	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "dn_user", "about": strings.Repeat("b", 301),
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("overlong about status = %d, want 400", rr.Code)
	}
}

func TestUpdateProfile_BroadcastCarriesEveryProfileField(t *testing.T) {
	database := newAuthTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	spy := &userUpdateSpy{}
	api.MountProfileRoutes(r, database, service.New(database, limiter), nil, limiter, nil, spy)
	token := profileCreateToken(t, database, "bc_user", 4)

	rr := patchJSON(t, r, "/api/v1/users/me", token, map[string]any{
		"username": "bc_user", "display_name": "Broadcaster", "about": "hi",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if len(spy.got) != 1 {
		t.Fatalf("broadcasts = %d, want 1", len(spy.got))
	}
	u := spy.got[0]
	// user_update replaces the client's copy wholesale, so a broadcast that
	// omits a field would silently blank it everywhere.
	if u.DisplayName == nil || *u.DisplayName != "Broadcaster" {
		t.Errorf("broadcast display_name = %v", u.DisplayName)
	}
	if u.About == nil || *u.About != "hi" {
		t.Errorf("broadcast about = %v", u.About)
	}
	if u.Username != "bc_user" {
		t.Errorf("broadcast username = %q", u.Username)
	}
}

func TestLogout_ClearsCustomStatus(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	token := profileCreateToken(t, database, "logout_status", 4)

	user, err := database.GetUserByUsername(context.Background(), "logout_status")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	text := "in a meeting"
	if err := database.UpdateUserCustomStatus(context.Background(), user.ID, &text); err != nil {
		t.Fatalf("UpdateUserCustomStatus: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", bytes.NewReader(nil))
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	after, _ := database.GetUserByID(context.Background(), user.ID)
	if after.CustomStatus != nil {
		t.Errorf("custom_status = %q, want cleared on logout", *after.CustomStatus)
	}
}

// userUpdateSpy captures the user_update broadcasts the profile routes emit.
type userUpdateSpy struct {
	got []ws.UserUpdate
}

func (s *userUpdateSpy) BroadcastUserUpdate(u ws.UserUpdate) {
	s.got = append(s.got, u)
}
