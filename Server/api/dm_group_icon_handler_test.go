package api_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// gatedStore wraps the real store. gate, when set, makes the next Save block
// after the bytes are written until the test releases it, which is how a test
// holds one member's upload in flight. onSave runs after every Save.
type gatedStore struct {
	*storage.Storage
	mu      sync.Mutex
	gate    chan struct{} // consumed by the first Save that sees it
	entered chan struct{} // closed when the gated Save has written its bytes
	onSave  func(id string)
	deleted []string
}

func (s *gatedStore) Save(id string, r io.Reader) (int64, error) {
	n, err := s.Storage.Save(id, r)
	if err != nil {
		return n, err
	}
	s.mu.Lock()
	gate, entered := s.gate, s.entered
	s.gate = nil
	hook := s.onSave
	s.mu.Unlock()
	if hook != nil {
		hook(id)
	}
	if gate != nil {
		close(entered)
		<-gate
	}
	return n, nil
}

func (s *gatedStore) Delete(id string) error {
	s.mu.Lock()
	s.deleted = append(s.deleted, id)
	s.mu.Unlock()
	return s.Storage.Delete(id)
}

type iconFixture struct {
	database *db.DB
	router   http.Handler
	bc       *recordingBroadcaster
	store    *gatedStore
	tokens   map[string]string
	ids      map[string]int64
	group    int64
}

// newIconFixture is a group of alice (owner), bob and carol, with dave outside
// it, on the real migrated schema, with the upload routes mounted so a file can
// be fetched back.
func newIconFixture(t *testing.T) *iconFixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err = db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	store, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	gs := &gatedStore{Storage: store}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	bc := &recordingBroadcaster{}
	r := chi.NewRouter()
	api.MountDMRoutes(r, svc, bc, limiter, gs)
	api.MountUploadRoutes(r, service.NewSessionService(database), gs, limiter, nil, svc.Uploads)

	f := &iconFixture{database: database, router: r, bc: bc, store: gs, tokens: map[string]string{}, ids: map[string]int64{}}
	for _, name := range []string{"alice", "bob", "carol", "dave"} {
		f.tokens[name] = dmCreateToken(t, database, name, 4)
		u, uErr := database.GetUserByUsername(context.Background(), name)
		if uErr != nil || u == nil {
			t.Fatalf("GetUserByUsername %s: %v", name, uErr)
		}
		f.ids[name] = u.ID
	}
	info := decodeDMInfo(t, dmPost(t, r, "/api/v1/dms/group", f.tokens["alice"], map[string]any{
		"recipient_ids": []int64{f.ids["bob"], f.ids["carol"]},
	}))
	f.group = info.ChannelID
	bc.reset()
	return f
}

func (f *iconFixture) iconPath() string { return fmt.Sprintf("/api/v1/dms/%d/icon", f.group) }

func (f *iconFixture) upload(t *testing.T, user string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	return f.uploadTo(t, f.iconPath(), user, content)
}

func (f *iconFixture) uploadTo(t *testing.T, path, user string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, "file", "icon.png", content)
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+f.tokens[user])
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	f.router.ServeHTTP(rr, req)
	return rr
}

func (f *iconFixture) clear(t *testing.T, user string) *httptest.ResponseRecorder {
	t.Helper()
	return dmDelete(t, f.router, f.iconPath(), f.tokens[user])
}

func (f *iconFixture) icon(t *testing.T) string {
	t.Helper()
	_, icon, err := f.database.GetGroupDMMeta(context.Background(), f.group)
	if err != nil {
		t.Fatalf("GetGroupDMMeta: %v", err)
	}
	return icon
}

func (f *iconFixture) iconRows(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind = 6`, f.group).Scan(&n); err != nil {
		t.Fatalf("count icon rows: %v", err)
	}
	return n
}

func (f *iconFixture) attachmentCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM attachments`).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	return n
}

func (f *iconFixture) fetch(t *testing.T, user, id string) int {
	t.Helper()
	return doServeFile(t, f.router, id, f.tokens[user], nil).Code
}

func iconID(t *testing.T, info db.DMChannelInfo) string {
	t.Helper()
	id, ok := strings.CutPrefix(info.Icon, "/api/v1/files/")
	if !ok || id == "" {
		t.Fatalf("icon = %q, want a /api/v1/files/ URL", info.Icon)
	}
	return id
}

func TestUploadGroupIcon_SetsIconRowAndRefresh(t *testing.T) {
	f := newIconFixture(t)
	rr := f.upload(t, "bob", makePNGBytes(t, 64, 64)) // a member who is not the owner
	if rr.Code != http.StatusOK {
		t.Fatalf("upload = %d %s, want 200", rr.Code, rr.Body.String())
	}
	info := decodeDMInfo(t, rr)
	id := iconID(t, info)
	if f.icon(t) != id {
		t.Errorf("dm_icon = %q, want %q", f.icon(t), id)
	}
	if f.iconRows(t) != 1 {
		t.Errorf("icon rows = %d, want 1", f.iconRows(t))
	}

	// Refreshed opens to all three members first, then the row.
	kinds := f.bc.kinds()
	rowsAt := slices.Index(kinds, "rows")
	if rowsAt != len(kinds)-1 {
		t.Fatalf("events = %v, want the rows last", kinds)
	}
	for _, want := range []string{"open:" + fmt.Sprint(f.ids["alice"]), "open:" + fmt.Sprint(f.ids["bob"]), "open:" + fmt.Sprint(f.ids["carol"])} {
		if at := slices.Index(kinds, want); at < 0 || at > rowsAt {
			t.Errorf("%s must precede the rows: %v", want, kinds)
		}
	}
	open := f.bc.find("open", f.ids["alice"])
	if open == nil || open.payload["icon"] != info.Icon {
		t.Errorf("alice's dm_channel_open icon = %v, want %q", open, info.Icon)
	}
	rows := f.bc.find("rows", 0)
	if rows == nil || len(rows.rows) != 1 {
		t.Fatalf("rows = %+v, want one group_icon", rows)
	}
	row := rows.rows[0]
	if row.Kind != "group_icon" || row.IconRemoved || row.Author == nil || row.Author.ID != f.ids["bob"] {
		t.Errorf("row = %+v, want a group_icon by bob that set an icon", row)
	}

	// The members see it in GET /dms, and may fetch the file.
	list := dmDo(t, f.router, http.MethodGet, "/api/v1/dms", f.tokens["carol"], nil)
	if !strings.Contains(list.Body.String(), `"icon":"`+info.Icon+`"`) {
		t.Errorf("GET /dms for carol lacks the icon: %s", list.Body.String())
	}
	for _, u := range []string{"alice", "bob", "carol"} {
		if got := f.fetch(t, u, id); got != http.StatusOK {
			t.Errorf("%s fetch = %d, want 200", u, got)
		}
	}
}

func TestUploadGroupIcon_RejectsOversizeWrongTypeAndBadTargets(t *testing.T) {
	f := newIconFixture(t)
	if rr := f.upload(t, "bob", []byte("this is plain text, not a PNG")); rr.Code != http.StatusBadRequest {
		t.Errorf("non-image = %d, want 400", rr.Code)
	}
	if rr := f.upload(t, "bob", makePNGBytes(t, 1025, 1025)); rr.Code != http.StatusBadRequest {
		t.Errorf("oversize dimensions = %d, want 400", rr.Code)
	}
	big := append(makePNGBytes(t, 8, 8), make([]byte, 1<<20)...)
	if rr := f.upload(t, "bob", big); rr.Code != http.StatusBadRequest {
		t.Errorf("over 1 MiB = %d, want 400", rr.Code)
	}
	// A group icon stays still: GIF is an avatar and banner type only (WP 8.7).
	rr := f.upload(t, "bob", makeAnimatedGIFBytes(t, 64, 64, 0))
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "must be a PNG, JPEG or WebP image") {
		t.Errorf("gif = %d %s, want 400 naming the still types", rr.Code, rr.Body.String())
	}
	if rr := f.upload(t, "dave", makePNGBytes(t, 8, 8)); rr.Code != http.StatusNotFound {
		t.Errorf("non-member = %d, want 404", rr.Code)
	}

	// A 1:1 DM has no icon.
	oneToOne := decodeDMInfo(t, dmPost(t, f.router, "/api/v1/dms", f.tokens["alice"], map[string]any{"recipient_id": f.ids["dave"]}))
	path := fmt.Sprintf("/api/v1/dms/%d/icon", oneToOne.ChannelID)
	if rr := f.uploadTo(t, path, "alice", makePNGBytes(t, 8, 8)); rr.Code != http.StatusBadRequest {
		t.Errorf("1:1 upload = %d, want 400", rr.Code)
	}
	if rr := dmDelete(t, f.router, path, f.tokens["alice"]); rr.Code != http.StatusBadRequest {
		t.Errorf("1:1 delete = %d, want 400", rr.Code)
	}

	if f.icon(t) != "" || f.iconRows(t) != 0 || f.attachmentCount(t) != 0 || len(f.bc.kinds()) != 0 {
		t.Errorf("a refused upload left state: icon %q, rows %d, attachments %d, events %v", f.icon(t), f.iconRows(t), f.attachmentCount(t), f.bc.kinds())
	}
}

func TestUploadGroupIcon_IsRateLimitedOnItsOwnKey(t *testing.T) {
	f := newIconFixture(t)
	for i := range 5 {
		if rr := f.upload(t, "bob", []byte("not an image")); rr.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d = %d, want 400", i+1, rr.Code)
		}
	}
	if rr := f.upload(t, "bob", []byte("not an image")); rr.Code != http.StatusTooManyRequests {
		t.Errorf("sixth attempt = %d, want 429", rr.Code)
	}
	// The shared group limit is a different key: clearing still answers.
	if rr := f.clear(t, "bob"); rr.Code != http.StatusOK {
		t.Errorf("clear after the upload budget = %d, want 200", rr.Code)
	}
}

func TestUploadGroupIcon_RouteNotMountedWithoutStore(t *testing.T) {
	f := newIconFixture(t)
	r := chi.NewRouter()
	api.MountDMRoutes(r, service.New(f.database, auth.NewRateLimiter()), f.bc, nil, nil)
	body, contentType := makeMultipartFile(t, "file", "icon.png", makePNGBytes(t, 8, 8))
	req := httptest.NewRequest(http.MethodPost, f.iconPath(), body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+f.tokens["bob"])
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound && rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("upload without a store = %d, want 404 or 405", rr.Code)
	}
	// Delete needs no store.
	if rr := dmDelete(t, r, f.iconPath(), f.tokens["bob"]); rr.Code != http.StatusOK {
		t.Errorf("delete without a store = %d, want 200", rr.Code)
	}
}

// Edge case 2: the uploader stops being a member between the upload and the
// transaction. The file and its record are deleted and nothing is written.
func TestUploadGroupIcon_FailedCommitUnrecordsFile(t *testing.T) {
	f := newIconFixture(t)
	f.store.onSave = func(string) {
		if _, err := f.database.LeaveGroupDM(context.Background(), f.ids["bob"], f.group, "bob left the group."); err != nil {
			t.Errorf("LeaveGroupDM: %v", err)
		}
	}
	rr := f.upload(t, "bob", makePNGBytes(t, 32, 32))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("upload by a member who just left = %d %s, want 404", rr.Code, rr.Body.String())
	}
	if f.icon(t) != "" {
		t.Errorf("dm_icon = %q, want none", f.icon(t))
	}
	if f.iconRows(t) != 0 {
		t.Errorf("icon rows = %d, want 0", f.iconRows(t))
	}
	if n := f.attachmentCount(t); n != 0 {
		t.Errorf("attachment rows = %d, want the record dropped", n)
	}
	if len(f.store.deleted) != 1 {
		t.Fatalf("store deletes = %v, want the stored file removed", f.store.deleted)
	}
	if _, err := f.store.Open(f.store.deleted[0]); err == nil {
		t.Errorf("the stored file is still on disk")
	}
	// Nothing about the icon went out.
	if rows := f.bc.find("rows", 0); rows != nil {
		for _, r := range rows.rows {
			if r.Kind == "group_icon" {
				t.Errorf("an icon row was fanned out: %+v", r)
			}
		}
	}
}

// Edge case 1: a member's upload is in flight while another member replaces the
// icon. The last committed write wins, the replaced file is no longer served to
// members and is reclaimed by the orphan sweep, and each committed change wrote
// exactly one row.
func TestUploadGroupIcon_ReplacedWhileUploadInFlight(t *testing.T) {
	f := newIconFixture(t)
	gate, entered := make(chan struct{}), make(chan struct{})
	f.store.mu.Lock()
	f.store.gate, f.store.entered = gate, entered
	f.store.mu.Unlock()

	slow := make(chan *httptest.ResponseRecorder, 1)
	go func() { slow <- f.upload(t, "carol", makePNGBytes(t, 40, 40)) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("carol's upload never reached the store")
	}

	// Carol's bytes are stored but her change has not committed. Bob replaces
	// the icon in the meantime.
	rr := f.upload(t, "bob", makePNGBytes(t, 41, 41))
	if rr.Code != http.StatusOK {
		t.Fatalf("bob's upload = %d %s", rr.Code, rr.Body.String())
	}
	bobID := iconID(t, decodeDMInfo(t, rr))
	if f.icon(t) != bobID || f.iconRows(t) != 1 {
		t.Fatalf("after bob: icon %q rows %d, want bob's icon and one row", f.icon(t), f.iconRows(t))
	}

	close(gate)
	rr = <-slow
	if rr.Code != http.StatusOK {
		t.Fatalf("carol's upload = %d %s", rr.Code, rr.Body.String())
	}
	carolID := iconID(t, decodeDMInfo(t, rr))
	if carolID == bobID {
		t.Fatal("test bug: both uploads got one id")
	}

	if f.icon(t) != carolID {
		t.Errorf("dm_icon = %q, want the last committed write (carol's %q)", f.icon(t), carolID)
	}
	if f.iconRows(t) != 2 {
		t.Errorf("icon rows = %d, want one per committed change (2)", f.iconRows(t))
	}
	if got := f.fetch(t, "alice", carolID); got != http.StatusOK {
		t.Errorf("member fetch of the live icon = %d, want 200", got)
	}
	if got := f.fetch(t, "alice", bobID); got != http.StatusForbidden {
		t.Errorf("member fetch of the replaced icon = %d, want 403", got)
	}

	swept, err := f.database.DeleteOrphanedAttachments(context.Background(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if !slices.Equal(swept, []string{bobID}) {
		t.Errorf("sweep removed %v, want only the replaced icon %s", swept, bobID)
	}
	if got := f.fetch(t, "bob", carolID); got != http.StatusOK {
		t.Errorf("the live icon was lost to the sweep: fetch = %d", got)
	}
}

func TestServeFile_GroupIconReadableByMembersOnly(t *testing.T) {
	f := newIconFixture(t)
	id := iconID(t, decodeDMInfo(t, f.upload(t, "bob", makePNGBytes(t, 32, 32))))

	if got := f.fetch(t, "dave", id); got != http.StatusForbidden {
		t.Errorf("non-member fetch = %d, want 403", got)
	}
	if got := f.fetch(t, "carol", id); got != http.StatusOK {
		t.Errorf("member fetch = %d, want 200", got)
	}

	// A removed member loses access.
	if rr := dmDelete(t, f.router, fmt.Sprintf("/api/v1/dms/%d/members/%d", f.group, f.ids["carol"]), f.tokens["alice"]); rr.Code != http.StatusNoContent {
		t.Fatalf("remove carol = %d %s", rr.Code, rr.Body.String())
	}
	if got := f.fetch(t, "carol", id); got != http.StatusForbidden {
		t.Errorf("removed member fetch = %d, want 403", got)
	}

	// After a replace, nobody but the uploader reads the old file.
	newID := iconID(t, decodeDMInfo(t, f.upload(t, "alice", makePNGBytes(t, 33, 33))))
	if got := f.fetch(t, "alice", id); got != http.StatusForbidden {
		t.Errorf("member fetch of the replaced icon = %d, want 403", got)
	}
	if got := f.fetch(t, "bob", id); got != http.StatusOK {
		t.Errorf("uploader fetch of the replaced icon = %d, want 200", got)
	}
	if got := f.fetch(t, "bob", newID); got != http.StatusOK {
		t.Errorf("member fetch of the new icon = %d, want 200", got)
	}

	// Clearing stops serving it too.
	if rr := f.clear(t, "alice"); rr.Code != http.StatusOK {
		t.Fatalf("clear = %d", rr.Code)
	}
	if got := f.fetch(t, "bob", newID); got != http.StatusForbidden {
		t.Errorf("member fetch of a cleared icon = %d, want 403", got)
	}
}

func TestDeleteGroupIcon_NoIconNoRow(t *testing.T) {
	f := newIconFixture(t)
	rr := f.clear(t, "bob")
	if rr.Code != http.StatusOK {
		t.Fatalf("clear with no icon = %d %s, want 200", rr.Code, rr.Body.String())
	}
	if info := decodeDMInfo(t, rr); info.Icon != "" || !info.IsGroup {
		t.Errorf("summary = %+v, want the group with no icon", info)
	}
	if f.iconRows(t) != 0 || len(f.bc.kinds()) != 0 {
		t.Errorf("clearing nothing wrote %d rows and sent %v", f.iconRows(t), f.bc.kinds())
	}
	if rr = f.clear(t, "dave"); rr.Code != http.StatusNotFound {
		t.Errorf("non-member clear = %d, want 404", rr.Code)
	}
}

func TestDeleteGroupIcon_ClearsAndFansOut(t *testing.T) {
	f := newIconFixture(t)
	if rr := f.upload(t, "bob", makePNGBytes(t, 16, 16)); rr.Code != http.StatusOK {
		t.Fatalf("upload = %d", rr.Code)
	}
	f.bc.reset()

	rr := f.clear(t, "carol")
	if rr.Code != http.StatusOK {
		t.Fatalf("clear = %d %s", rr.Code, rr.Body.String())
	}
	if info := decodeDMInfo(t, rr); info.Icon != "" {
		t.Errorf("summary icon = %q, want none", info.Icon)
	}
	if f.icon(t) != "" || f.iconRows(t) != 2 {
		t.Errorf("icon %q rows %d, want cleared with a set row and a clear row", f.icon(t), f.iconRows(t))
	}
	kinds := f.bc.kinds()
	if len(kinds) != 4 || kinds[3] != "rows" {
		t.Fatalf("events = %v, want three opens then the row", kinds)
	}
	rows := f.bc.find("rows", 0)
	if rows == nil || len(rows.rows) != 1 || !rows.rows[0].IconRemoved || rows.rows[0].Kind != "group_icon" {
		t.Errorf("rows = %+v, want one group_icon with icon_removed", rows)
	}
}
