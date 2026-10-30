package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// recordingRemovalBroadcaster captures what a removal tells the hub.
type recordingRemovalBroadcaster struct {
	changed []*service.AttachmentsChangedResult
	deleted []*service.DeleteMessageResult
}

func (b *recordingRemovalBroadcaster) AttachmentsChanged(_ context.Context, res *service.AttachmentsChangedResult) {
	b.changed = append(b.changed, res)
}

func (b *recordingRemovalBroadcaster) MessageDeletedByUpload(_ context.Context, res *service.DeleteMessageResult) {
	b.deleted = append(b.deleted, res)
}

type uploadsHarness struct {
	database *db.DB
	router   http.Handler
	svc      *service.Services
	files    *storage.Storage
	hub      *recordingRemovalBroadcaster
	channel  int64
}

func newUploadsHarness(t *testing.T) *uploadsHarness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	files, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	h := &uploadsHarness{database: database, files: files, hub: &recordingRemovalBroadcaster{}}
	limiter := auth.NewRateLimiter()
	h.svc = service.New(database, limiter)
	r := chi.NewRouter()
	api.MountUserUploadRoutes(r, h.svc, files, limiter, nil, h.hub)
	h.router = r
	h.channel, err = database.CreateChannel(context.Background(), "files", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *uploadsHarness) user(t *testing.T, name string) (token string, id int64) {
	t.Helper()
	token = chTestCreateToken(t, h.database, name, int(permissions.MemberRoleID))
	u, err := h.database.GetUserByUsername(context.Background(), name)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%q): %v", name, err)
	}
	return token, u.ID
}

// upload stores bytes on disk and records the attachment row; when text is not
// "-" it also sends a message with it. It returns the message id (0 when unsent).
func (h *uploadsHarness) upload(t *testing.T, userID int64, id, name, text string) int64 {
	t.Helper()
	ctx := context.Background()
	if _, err := h.files.Save(id, strings.NewReader("hello "+id)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := h.database.CreateAttachment(ctx, id, userID, name, id, "text/plain", 10, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if text == "-" {
		return 0
	}
	msgID, err := h.database.CreateMessage(ctx, h.channel, userID, text, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.LinkAttachmentsToMessage(ctx, msgID, userID, []string{id}); err != nil {
		t.Fatal(err)
	}
	return msgID
}

func (h *uploadsHarness) fileExists(id string) bool {
	f, err := h.files.Open(id)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

func uploadsDelete(t *testing.T, router http.Handler, id, token string) *httptest.ResponseRecorder {
	t.Helper()
	return chDelete(t, router, "/api/v1/users/me/uploads/"+id, token)
}

type ownUploadsBody struct {
	Items []struct {
		Attachment struct {
			ID string `json:"id"`
		} `json:"attachment"`
		State     string `json:"state"`
		Removable bool   `json:"removable"`
		ChannelID *int64 `json:"channel_id"`
		MessageID *int64 `json:"message_id"`
	} `json:"items"`
	NextCursor string `json:"next_cursor"`
}

func (h *uploadsHarness) list(t *testing.T, query, token string) ownUploadsBody {
	t.Helper()
	rr := chGet(t, h.router, "/api/v1/users/me/uploads"+query, token)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET uploads%s = %d: %s", query, rr.Code, rr.Body.String())
	}
	var body ownUploadsBody
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

func TestOwnStorage_ShapeAndUnlimitedQuota(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "storer")

	// A user who never uploaded has no counter row: zero, and 0 quota is unlimited.
	rr := chGet(t, h.router, "/api/v1/users/me/storage", token)
	if rr.Code != http.StatusOK || strings.TrimSpace(rr.Body.String()) != `{"used_bytes":0,"quota_bytes":0}` {
		t.Fatalf("empty = %d %s", rr.Code, rr.Body.String())
	}

	h.svc.Uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: 5000})
	if _, err := h.database.ChargeUserStorage(context.Background(), uid, 1234, 0); err != nil {
		t.Fatal(err)
	}
	rr = chGet(t, h.router, "/api/v1/users/me/storage", token)
	if rr.Code != http.StatusOK || strings.TrimSpace(rr.Body.String()) != `{"used_bytes":1234,"quota_bytes":5000}` {
		t.Errorf("with quota = %d %s", rr.Code, rr.Body.String())
	}
}

func TestOwnUploadRoutes_RequireAuth(t *testing.T) {
	h := newUploadsHarness(t)
	for _, path := range []string{"/api/v1/users/me/storage", "/api/v1/users/me/uploads"} {
		if rr := chGet(t, h.router, path, ""); rr.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", path, rr.Code)
		}
	}
	if rr := uploadsDelete(t, h.router, "x", ""); rr.Code != http.StatusUnauthorized {
		t.Errorf("DELETE = %d, want 401", rr.Code)
	}
}

func TestListOwnUploads_OnlyMineWithStatesAndPaging(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "lister")
	_, otherID := h.user(t, "someone")
	h.upload(t, uid, "mine-sent", "sent.txt", "hi")
	h.upload(t, uid, "mine-pending", "pending.txt", "-")
	h.upload(t, uid, "mine-avatar", "avatar.png", "-")
	h.upload(t, otherID, "theirs", "theirs.txt", "hi")
	if _, err := h.database.ExecContext(context.Background(), `UPDATE users SET avatar = '/api/v1/files/mine-avatar' WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}

	all := h.list(t, "?sort=largest", token)
	states := map[string]string{}
	for _, it := range all.Items {
		states[it.Attachment.ID] = fmt.Sprintf("%s/%v", it.State, it.Removable)
	}
	want := map[string]string{"mine-sent": "message/true", "mine-pending": "pending/true", "mine-avatar": "avatar/false"}
	if fmt.Sprint(states) != fmt.Sprint(want) {
		t.Errorf("states = %v, want %v (and nothing of someone else's)", states, want)
	}

	first := h.list(t, "?limit=2", token)
	if len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	rest := h.list(t, "?limit=2&cursor="+first.NextCursor, token)
	if len(rest.Items) != 1 || rest.NextCursor != "" {
		t.Errorf("second page = %+v", rest)
	}
	if got := h.list(t, "?q=PENDING", token); len(got.Items) != 1 || got.Items[0].Attachment.ID != "mine-pending" {
		t.Errorf("q filter = %+v", got)
	}
}

func TestListOwnUploads_BadParametersAre400(t *testing.T) {
	h := newUploadsHarness(t)
	token, _ := h.user(t, "badparams")
	for _, q := range []string{"?sort=oldest", "?limit=0", "?limit=abc", "?cursor=nonsense!", "?q=" + strings.Repeat("x", 101)} {
		if rr := chGet(t, h.router, "/api/v1/users/me/uploads"+q, token); rr.Code != http.StatusBadRequest {
			t.Errorf("GET uploads%s = %d, want 400", q[:min(len(q), 20)], rr.Code)
		}
	}
}

func TestRemoveOwnUpload_204RemovesRowBytesAndAnnounces(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "remover")
	msgID := h.upload(t, uid, "gone-soon", "a.txt", "keep this text")
	if _, err := h.database.ChargeUserStorage(context.Background(), uid, 10, 0); err != nil {
		t.Fatal(err)
	}

	rr := uploadsDelete(t, h.router, "gone-soon", token)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", rr.Code, rr.Body.String())
	}
	if h.fileExists("gone-soon") {
		t.Error("the bytes are still on disk")
	}
	if used, _ := h.svc.Uploads.StorageUsed(context.Background(), uid); used != 0 {
		t.Errorf("counter = %d, want 0", used)
	}
	if len(h.hub.changed) != 1 || len(h.hub.deleted) != 0 {
		t.Fatalf("broadcasts changed=%d deleted=%d, want 1/0", len(h.hub.changed), len(h.hub.deleted))
	}
	if c := h.hub.changed[0]; c.MessageID != msgID || c.Content != "keep this text" || c.Attachments == nil || len(c.Attachments) != 0 {
		t.Errorf("changed = %+v", c)
	}
	if got := h.list(t, "", token); len(got.Items) != 0 {
		t.Errorf("list after removal = %+v", got)
	}
}

func TestRemoveOwnUpload_LastFileOfBlankMessageDeletesIt(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "blanker")
	msgID := h.upload(t, uid, "only-file", "a.txt", "")
	if rr := uploadsDelete(t, h.router, "only-file", token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", rr.Code, rr.Body.String())
	}
	if len(h.hub.deleted) != 1 || len(h.hub.changed) != 0 || h.hub.deleted[0].MessageID != msgID {
		t.Errorf("broadcasts changed=%d deleted=%+v, want one delete of message %d", len(h.hub.changed), h.hub.deleted, msgID)
	}
}

func TestRemoveOwnUpload_PendingFileAnnouncesNothing(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "unsent")
	h.upload(t, uid, "never-sent", "a.txt", "-")
	if rr := uploadsDelete(t, h.router, "never-sent", token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d", rr.Code)
	}
	if h.fileExists("never-sent") || len(h.hub.changed)+len(h.hub.deleted) != 0 {
		t.Errorf("file exists %v, broadcasts %d", h.fileExists("never-sent"), len(h.hub.changed)+len(h.hub.deleted))
	}
}

func TestRemoveOwnUpload_NotFoundCases(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "mine404")
	otherToken, otherID := h.user(t, "theirs404")
	h.upload(t, otherID, "not-yours", "a.txt", "hi")

	if rr := uploadsDelete(t, h.router, "not-yours", token); rr.Code != http.StatusNotFound {
		t.Errorf("someone else's file = %d, want 404", rr.Code)
	}
	if !h.fileExists("not-yours") {
		t.Error("someone else's file was deleted from disk")
	}
	if rr := uploadsDelete(t, h.router, "no-such-id", token); rr.Code != http.StatusNotFound {
		t.Errorf("unknown id = %d, want 404", rr.Code)
	}
	h.upload(t, uid, "once", "a.txt", "-")
	if rr := uploadsDelete(t, h.router, "once", token); rr.Code != http.StatusNoContent {
		t.Fatalf("first removal = %d", rr.Code)
	}
	if rr := uploadsDelete(t, h.router, "once", token); rr.Code != http.StatusNotFound {
		t.Errorf("second removal = %d, want 404", rr.Code)
	}
	if rr := uploadsDelete(t, h.router, "not-yours", otherToken); rr.Code != http.StatusNoContent {
		t.Errorf("owner's removal = %d, want 204", rr.Code)
	}
}

func TestRemoveOwnUpload_InUseIs409AndKeepsEverything(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "inuse")
	h.upload(t, uid, "my-avatar", "a.png", "-")
	if _, err := h.database.ExecContext(context.Background(), `UPDATE users SET avatar = '/api/v1/files/my-avatar' WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}
	rr := uploadsDelete(t, h.router, "my-avatar", token)
	if rr.Code != http.StatusConflict {
		t.Fatalf("DELETE avatar = %d, want 409: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "in use") {
		t.Errorf("body = %s, want a plain in-use message", rr.Body.String())
	}
	if !h.fileExists("my-avatar") {
		t.Error("the avatar's bytes were deleted")
	}
	if got := h.list(t, "", token); len(got.Items) != 1 {
		t.Errorf("list = %+v, want the avatar still listed", got)
	}
}

func TestRemoveOwnUpload_BytesStayWhileAnotherRowNamesThem(t *testing.T) {
	h := newUploadsHarness(t)
	token, uid := h.user(t, "sharer")
	h.upload(t, uid, "shared-a", "a.txt", "-")
	if _, err := h.database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size) VALUES ('shared-b', ?, 'b.txt', 'shared-a', 'text/plain', 1)`, uid); err != nil {
		t.Fatal(err)
	}
	if rr := uploadsDelete(t, h.router, "shared-a", token); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d", rr.Code)
	}
	if !h.fileExists("shared-a") {
		t.Error("bytes still named by another row were deleted")
	}
}
