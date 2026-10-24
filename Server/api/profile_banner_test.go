package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// Profile banners (WP 6.11b): POST and DELETE /api/v1/users/me/banner, the
// banner_color field of PATCH /users/me, and the file route's grant.

func buildBannerRouter(database *db.DB, store *storage.Storage, spy *userUpdateSpy) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountProfileRoutes(r, svc, store, limiter, nil, spy, nil)
	api.MountUploadRoutes(r, service.NewSessionService(database), store, limiter, nil, svc.Uploads)
	return r
}

func doBannerUpload(t *testing.T, router http.Handler, token, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	return doProfileImageUpload(t, router, "/api/v1/users/me/banner", token, filename, content)
}

func doProfileImageUpload(t *testing.T, router http.Handler, path, token, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, "file", filename, content)
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func TestUploadBanner_LimitsAndTypes(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})

	oversized := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, (4<<20)+1)...)
	cases := []struct {
		name string
		body []byte
		want int
	}{
		{"1920x960 ok", makePNGBytes(t, 1920, 960), http.StatusCreated},
		{"1x1 ok", makePNGBytes(t, 1, 1), http.StatusCreated},
		{"1921 wide refused", makePNGBytes(t, 1921, 100), http.StatusBadRequest},
		{"961 tall refused", makePNGBytes(t, 100, 961), http.StatusBadRequest},
		{"animated gif ok", makeAnimatedGIFBytes(t, 600, 240, 0), http.StatusCreated},
		{"3 MiB animated gif ok", makeAnimatedGIFBytes(t, 600, 240, 3<<20), http.StatusCreated},
		{"1921 wide gif refused", makeAnimatedGIFBytes(t, 1921, 100, 0), http.StatusBadRequest},
		{"text refused", []byte("not an image"), http.StatusBadRequest},
		{"4 MiB + 1 refused", oversized, http.StatusBadRequest},
	}
	for i, tc := range cases {
		token := uploadCreateToken(t, database, "banner_lim_"+string(rune('a'+i)), 4)
		rr := doBannerUpload(t, router, token, "b.png", tc.body)
		if rr.Code != tc.want {
			t.Errorf("%s: status = %d, want %d; body = %s", tc.name, rr.Code, tc.want, rr.Body.String())
		}
	}
	// The refusal text names the banner, not the avatar.
	token := uploadCreateToken(t, database, "banner_msg", 4)
	rr := doBannerUpload(t, router, token, "b.png", makePNGBytes(t, 1921, 100))
	if !strings.Contains(rr.Body.String(), "banner must be at most 1920x960") {
		t.Errorf("message = %s", rr.Body.String())
	}
	rr = doBannerUpload(t, router, token, "b.png", oversized)
	if !strings.Contains(rr.Body.String(), "banner must be at most 4096 KB") {
		t.Errorf("size message = %s", rr.Body.String())
	}
	rr = doBannerUpload(t, router, token, "b.txt", []byte("not an image"))
	if !strings.Contains(rr.Body.String(), "banner must be a PNG, JPEG, WebP or GIF image") {
		t.Errorf("type message = %s", rr.Body.String())
	}
}

func TestUploadBanner_StoresAndSetsBannerID(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	spy := &userUpdateSpy{}
	router := buildBannerRouter(database, store, spy)
	token := uploadCreateToken(t, database, "banner_owner", 4)

	rr := doBannerUpload(t, router, token, "b.png", makePNGBytes(t, 640, 256))
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	id := uploadedID(t, rr)
	u, err := database.GetUserByUsername(context.Background(), "banner_owner")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.BannerID == nil || *u.BannerID != id {
		t.Fatalf("banner_id = %v, want %q", u.BannerID, id)
	}
	if u.Avatar != nil {
		t.Errorf("a banner upload set the avatar to %q", *u.Avatar)
	}
	if len(spy.got) != 1 || spy.got[0].Banner == nil || *spy.got[0].Banner != "/api/v1/files/"+id {
		t.Fatalf("broadcasts = %+v, want one user_update carrying the banner path", spy.got)
	}
}

func TestUploadBanner_QuotaCharged(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	token := uploadCreateToken(t, database, "banner_quota", 4)
	body := makePNGBytes(t, 300, 120)

	rr := doBannerUpload(t, router, token, "b.png", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var used int64
	if err := database.QueryRowContext(context.Background(), `SELECT COALESCE(SUM(bytes_used), 0) FROM user_storage`).Scan(&used); err != nil {
		t.Fatalf("user_storage: %v", err)
	}
	if used != int64(len(body)) {
		t.Errorf("bytes_used = %d, want %d (the banner counts against the quota)", used, len(body))
	}
}

func TestUploadBanner_ProfileWriteFailsUnrecords(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	token := uploadCreateToken(t, database, "banner_failer", 4)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `CREATE TRIGGER fail_banner BEFORE UPDATE OF banner_id ON users BEGIN SELECT RAISE(ABORT, 'forced'); END`); err != nil {
		t.Fatalf("trigger: %v", err)
	}

	rr := doBannerUpload(t, router, token, "b.png", makePNGBytes(t, 64, 32))
	if rr.Code < 500 {
		t.Fatalf("status = %d, want a server error; body = %s", rr.Code, rr.Body.String())
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("attachments = %d, %v; want 0", rows, err)
	}
	var used int64
	if err := database.QueryRowContext(ctx, `SELECT COALESCE(SUM(bytes_used), 0) FROM user_storage`).Scan(&used); err != nil || used != 0 {
		t.Fatalf("bytes_used = %d, %v; want 0", used, err)
	}
}

// A rename that landed after this request authenticated must survive: the
// upload sends no username snapshot.
func TestUploadBanner_KeepsConcurrentRename(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	token := uploadCreateToken(t, database, "banner_old_name", 4)
	ctx := context.Background()
	u, err := database.GetUserByUsername(ctx, "banner_old_name")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	about := "kept about"
	if err := database.UpdateUserProfile(ctx, u.ID, "banner_new_name", nil, nil, &about, nil, nil); err != nil {
		t.Fatalf("rename: %v", err)
	}

	rr := doBannerUpload(t, router, token, "b.png", makePNGBytes(t, 64, 32))
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	after, _ := database.GetUserByID(ctx, u.ID)
	if after.Username != "banner_new_name" || after.About == nil || *after.About != about {
		t.Errorf("username/about = %q/%v, want the concurrent edit kept", after.Username, after.About)
	}
	if after.BannerID == nil {
		t.Error("banner_id not set")
	}
}

func TestDeleteBanner_ClearsAndBroadcastsNull(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	spy := &userUpdateSpy{}
	router := buildBannerRouter(database, store, spy)
	ownerToken := uploadCreateToken(t, database, "bdel_owner", 4)
	peerToken := uploadCreateToken(t, database, "bdel_peer", 4)

	up := doBannerUpload(t, router, ownerToken, "b.png", makePNGBytes(t, 64, 32))
	if up.Code != http.StatusCreated {
		t.Fatalf("upload status = %d; body = %s", up.Code, up.Body.String())
	}
	id := uploadedID(t, up)
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusOK {
		t.Fatalf("peer fetch before delete = %d, want 200", got.Code)
	}
	spy.got = nil

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/banner", nil)
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v, ok := body["banner"]; !ok || v != nil {
		t.Errorf("response banner = %v (present %v), want null", v, ok)
	}
	u, _ := database.GetUserByUsername(context.Background(), "bdel_owner")
	if u.BannerID != nil {
		t.Errorf("stored banner_id = %q, want NULL", *u.BannerID)
	}
	if len(spy.got) != 1 || spy.got[0].Banner != nil || spy.got[0].UserID != u.ID {
		t.Fatalf("broadcasts = %+v, want one user_update with banner null", spy.got)
	}
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch after delete = %d, want 403", got.Code)
	}
}

func TestPatchBannerColor_ValidatesAndClears(t *testing.T) {
	database := newAuthTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	spy := &userUpdateSpy{}
	api.MountProfileRoutes(r, service.New(database, limiter), nil, limiter, nil, spy, nil)
	token := profileCreateToken(t, database, "color_user", 4)
	patch := func(color string) *httptest.ResponseRecorder {
		return patchJSON(t, r, "/api/v1/users/me", token, map[string]any{"username": "color_user", "banner_color": color})
	}

	rr := patch("  #ABCDEF ")
	if rr.Code != http.StatusOK {
		t.Fatalf("set status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["banner_color"] != "#abcdef" {
		t.Errorf("response banner_color = %v, want lower-cased #abcdef", body["banner_color"])
	}
	if len(spy.got) != 1 || spy.got[0].BannerColor == nil || *spy.got[0].BannerColor != "#abcdef" {
		t.Fatalf("broadcasts = %+v", spy.got)
	}
	if rr := patch("#fa0"); rr.Code != http.StatusOK {
		t.Errorf("short form status = %d, want 200", rr.Code)
	}
	for _, bad := range []string{"red", "#12345", "#gggggg", "abcdef", "url(x)", "#1234567"} {
		if rr := patch(bad); rr.Code != http.StatusBadRequest {
			t.Errorf("%q status = %d, want 400", bad, rr.Code)
		}
	}
	if rr := patch(strings.Repeat("a", 64)); rr.Code != http.StatusBadRequest {
		t.Errorf("overlong colour status = %d, want 400", rr.Code)
	}
	u, _ := database.GetUserByUsername(context.Background(), "color_user")
	if u.BannerColor == nil || *u.BannerColor != "#fa0" {
		t.Fatalf("stored colour = %v, want #fa0 (refusals must not move it)", u.BannerColor)
	}
	rr = patch("")
	if rr.Code != http.StatusOK {
		t.Fatalf("clear status = %d", rr.Code)
	}
	u, _ = database.GetUserByUsername(context.Background(), "color_user")
	if u.BannerColor != nil {
		t.Errorf("colour after clear = %q, want NULL", *u.BannerColor)
	}
	body = nil
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if v, ok := body["banner_color"]; !ok || v != nil {
		t.Errorf("cleared response banner_color = %v (present %v), want null", v, ok)
	}
}

// PATCH /users/me has no banner id or URL field: an image can only be set by
// uploading it to this server, so there is nothing for the server to fetch.
func TestPatchProfile_IgnoresBannerURL(t *testing.T) {
	database := newAuthTestDB(t)
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, service.New(database, limiter), nil, limiter, nil, &userUpdateSpy{}, nil)
	token := profileCreateToken(t, database, "no_banner_url", 4)

	rr := patchJSON(t, r, "/api/v1/users/me", token, map[string]any{
		"username":  "no_banner_url",
		"banner":    "https://example.com/b.png",
		"banner_id": "11111111-1111-1111-1111-111111111111",
		"bannerId":  "x",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["banner"] != nil {
		t.Errorf("response banner = %v, want null", body["banner"])
	}
	u, _ := database.GetUserByUsername(context.Background(), "no_banner_url")
	if u.BannerID != nil {
		t.Errorf("a PATCH set banner_id to %q", *u.BannerID)
	}
}

func TestServeFile_BannerReadableWhileLive(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	ownerToken := uploadCreateToken(t, database, "bread_owner", 4)
	peerToken := uploadCreateToken(t, database, "bread_peer", 4)

	id := uploadedID(t, doBannerUpload(t, router, ownerToken, "b.png", makePNGBytes(t, 64, 32)))
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusOK {
		t.Fatalf("peer fetch status = %d, want 200; body = %s", got.Code, got.Body.String())
	}
	// A file nobody named stays private to its uploader.
	other := uploadedID(t, doUpload(t, router, ownerToken, "file", "x.png", makePNGBytes(t, 8, 8)))
	if got := doServeFile(t, router, other, peerToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch of an ordinary unlinked upload = %d, want 403", got.Code)
	}
}

func TestServeFile_ReplacedBannerRefused(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	ownerToken := uploadCreateToken(t, database, "brep_owner", 4)
	peerToken := uploadCreateToken(t, database, "brep_peer", 4)

	oldID := uploadedID(t, doBannerUpload(t, router, ownerToken, "b1.png", makePNGBytes(t, 64, 32)))
	newID := uploadedID(t, doBannerUpload(t, router, ownerToken, "b2.png", makePNGBytes(t, 65, 32)))
	if got := doServeFile(t, router, oldID, peerToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch of the replaced banner = %d, want 403", got.Code)
	}
	if got := doServeFile(t, router, oldID, ownerToken, nil); got.Code != http.StatusOK {
		t.Errorf("uploader fetch of the replaced banner = %d, want 200", got.Code)
	}
	if got := doServeFile(t, router, newID, peerToken, nil); got.Code != http.StatusOK {
		t.Errorf("peer fetch of the new banner = %d, want 200", got.Code)
	}
	if got := doServeThumb(t, router, oldID, peerToken); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch of the replaced banner's thumbnail = %d, want 403", got.Code)
	}
}

// Denying a pending application clears banner_id (DenyPendingUser), so the
// file stops being anyone's live banner and a peer is refused it.
func TestServeFile_DeniedOwnersBannerRefused(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildBannerRouter(database, store, &userUpdateSpy{})
	ownerToken := uploadCreateToken(t, database, "bden_owner", 4)
	peerToken := uploadCreateToken(t, database, "bden_peer", 4)

	id := uploadedID(t, doBannerUpload(t, router, ownerToken, "b.png", makePNGBytes(t, 64, 32)))
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusOK {
		t.Fatalf("peer fetch before deny = %d, want 200", got.Code)
	}
	owner, err := database.GetUserByUsername(context.Background(), "bden_owner")
	if err != nil || owner == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	// DenyPendingUser only touches a still-pending row.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET registration_status = 'pending' WHERE id = ?`, owner.ID); err != nil {
		t.Fatalf("mark pending: %v", err)
	}
	if err := database.DenyPendingUser(context.Background(), owner.ID); err != nil {
		t.Fatalf("DenyPendingUser: %v", err)
	}
	if got := doServeFile(t, router, id, peerToken, nil); got.Code != http.StatusForbidden {
		t.Errorf("peer fetch after deny = %d, want 403", got.Code)
	}
}

// The avatar limits: 2 MiB (WP 8.7), at most 1024x1024, PNG/JPEG/WebP/GIF,
// and the refusal wording.
func TestAvatarUpload_Limits(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	oversized := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, (2<<20)+1)...)
	cases := []struct {
		name string
		body []byte
		want int
		msg  string
	}{
		{"1024x1024 ok", makePNGBytes(t, 1024, 1024), http.StatusCreated, ""},
		{"1025 wide refused", makePNGBytes(t, 1025, 10), http.StatusBadRequest, "avatar must be at most 1024x1024 pixels (got 1025x10)"},
		{"1025 tall refused", makePNGBytes(t, 10, 1025), http.StatusBadRequest, "avatar must be at most 1024x1024 pixels (got 10x1025)"},
		{"banner-sized refused", makePNGBytes(t, 1920, 960), http.StatusBadRequest, "avatar must be at most 1024x1024"},
		{"animated gif ok", makeAnimatedGIFBytes(t, 128, 128, 0), http.StatusCreated, ""},
		{"1.5 MiB animated gif ok", makeAnimatedGIFBytes(t, 128, 128, 3<<19), http.StatusCreated, ""},
		{"1025 wide gif refused", makeAnimatedGIFBytes(t, 1025, 10, 0), http.StatusBadRequest, "avatar must be at most 1024x1024 pixels (got 1025x10)"},
		{"text refused", []byte("not an image"), http.StatusBadRequest, "avatar must be a PNG, JPEG, WebP or GIF image"},
		{"2 MiB + 1 refused", oversized, http.StatusBadRequest, "avatar must be at most 2048 KB"},
	}
	for i, tc := range cases {
		token := uploadCreateToken(t, database, "avlim_"+string(rune('a'+i)), 4)
		rr := doAvatarUpload(t, router, token, "a.png", tc.body)
		if rr.Code != tc.want {
			t.Errorf("%s: status = %d, want %d; body = %s", tc.name, rr.Code, tc.want, rr.Body.String())
		}
		if tc.msg != "" && !strings.Contains(rr.Body.String(), tc.msg) {
			t.Errorf("%s: body = %s, want it to contain %q", tc.name, rr.Body.String(), tc.msg)
		}
	}
}
