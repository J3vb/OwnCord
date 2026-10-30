package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

type mediaPage struct {
	Items []struct {
		Attachment struct {
			ID       string `json:"id"`
			Filename string `json:"filename"`
			URL      string `json:"url"`
		} `json:"attachment"`
		MessageID int64 `json:"message_id"`
		User      struct {
			Username string `json:"username"`
		} `json:"user"`
		Timestamp string `json:"timestamp"`
	} `json:"items"`
	NextCursor string `json:"next_cursor"`
}

func newMediaRouter(t *testing.T) (*db.DB, http.Handler) {
	database, router, _ := newMediaRouterWithServices(t)
	return database, router
}

func newMediaRouterWithServices(t *testing.T) (*db.DB, http.Handler, *service.Services) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountChannelMediaRoutes(r, svc, limiter, nil)
	return database, r, svc
}

// postMedia posts one message as the named user at ts with one image per file name.
func postMedia(t *testing.T, database *db.DB, ch int64, username, ts string, files ...string) {
	t.Helper()
	ctx := context.Background()
	u, err := database.GetUserByUsername(ctx, username)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%q): %v", username, err)
	}
	msgID, err := database.CreateMessage(ctx, ch, u.ID, "", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE messages SET timestamp = ? WHERE id = ?`, ts, msgID); err != nil {
		t.Fatalf("timestamp: %v", err)
	}
	ids := make([]string, 0, len(files))
	for i, name := range files {
		id := fmt.Sprintf("m%d-%d", msgID, i)
		if err := database.CreateAttachment(ctx, id, u.ID, name, id, "image/png", 1, nil, nil); err != nil {
			t.Fatalf("CreateAttachment: %v", err)
		}
		ids = append(ids, id)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, msgID, u.ID, ids); err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
}

func decodeMediaPage(t *testing.T, router http.Handler, path, token string) mediaPage {
	t.Helper()
	rr := chGet(t, router, path, token)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", path, rr.Code, rr.Body.String())
	}
	var page mediaPage
	if err := json.NewDecoder(rr.Body).Decode(&page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return page
}

func TestChannelMedia_PagesWithCursor(t *testing.T) {
	database, router := newMediaRouter(t)
	token := chTestCreateToken(t, database, "media-member", int(permissions.MemberRoleID))
	ch, _ := database.CreateChannel(context.Background(), "photos", "text", "", "", 0)
	postMedia(t, database, ch, "media-member", "2026-01-01 10:00:00", "one.png")
	postMedia(t, database, ch, "media-member", "2026-01-02 10:00:00", "two.png", "three.png")

	base := fmt.Sprintf("/api/v1/channels/%d/media", ch)
	first := decodeMediaPage(t, router, base+"?limit=2", token)
	if len(first.Items) != 2 || first.Items[0].Attachment.Filename != "two.png" || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	if it := first.Items[0]; it.User.Username != "media-member" || it.Attachment.URL == "" || it.MessageID == 0 {
		t.Errorf("item = %+v", it)
	}
	rest := decodeMediaPage(t, router, base+"?limit=2&cursor="+first.NextCursor, token)
	if len(rest.Items) != 1 || rest.Items[0].Attachment.Filename != "one.png" || rest.NextCursor != "" {
		t.Fatalf("second page = %+v", rest)
	}
}

func TestChannelMedia_RespectsReadPermission(t *testing.T) {
	database, router := newMediaRouter(t)
	token := chTestCreateToken(t, database, "media-denied", int(permissions.MemberRoleID))
	ch, _ := database.CreateChannel(context.Background(), "secret", "text", "", "", 0)
	postMedia(t, database, ch, "media-denied", "2026-01-01 10:00:00", "hidden.png")
	denyReadMessages(t, database, ch, permissions.MemberRoleID)

	for _, path := range []string{"/api/v1/channels/%d/media", "/api/v1/channels/%d/media/months"} {
		if rr := chGet(t, router, fmt.Sprintf(path, ch), token); rr.Code != http.StatusForbidden {
			t.Errorf("%s = %d, want 403: %s", path, rr.Code, rr.Body.String())
		}
	}
	if rr := chGet(t, router, "/api/v1/channels/99999/media", token); rr.Code != http.StatusNotFound {
		t.Errorf("unknown channel = %d, want 404", rr.Code)
	}
	if rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/media", ch), ""); rr.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rr.Code)
	}
}

func TestChannelMedia_RejectsBadParameters(t *testing.T) {
	database, router := newMediaRouter(t)
	token := chTestCreateToken(t, database, "media-bad", int(permissions.MemberRoleID))
	ch, _ := database.CreateChannel(context.Background(), "photos", "text", "", "", 0)
	long := make([]byte, service.MediaNameMaxLen+1)
	for i := range long {
		long[i] = 'a'
	}
	for _, query := range []string{
		"kind=links", "order=random", "from=0", "from=x", "limit=0", "month=2026-13",
		"month=2026-01&tz=Not/AZone", "cursor=nope", "cursor=1_bad%27id", "q=" + string(long),
	} {
		path := fmt.Sprintf("/api/v1/channels/%d/media?%s", ch, query)
		if rr := chGet(t, router, path, token); rr.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", query, rr.Code)
		}
	}
}

func TestChannelMedia_MonthsUseTheCallersZone(t *testing.T) {
	database, router := newMediaRouter(t)
	token := chTestCreateToken(t, database, "media-tz", int(permissions.MemberRoleID))
	ch, _ := database.CreateChannel(context.Background(), "photos", "text", "", "", 0)
	// 23:30 UTC on 31 January is already February in Brussels (UTC+1).
	postMedia(t, database, ch, "media-tz", "2026-01-31 23:30:00", "late.png")
	postMedia(t, database, ch, "media-tz", "2026-01-15 12:00:00", "mid.png", "mid2.png")

	months := func(tz string) string {
		rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/media/months?tz=%s", ch, tz), token)
		if rr.Code != http.StatusOK {
			t.Fatalf("months = %d: %s", rr.Code, rr.Body.String())
		}
		var body struct {
			Months []service.MediaMonth `json:"months"`
		}
		if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return fmt.Sprint(body.Months)
	}
	if got, want := months("UTC"), "[{2026-01 3}]"; got != want {
		t.Errorf("UTC months = %s, want %s", got, want)
	}
	if got, want := months("Europe/Brussels"), "[{2026-02 1} {2026-01 2}]"; got != want {
		t.Errorf("Brussels months = %s, want %s", got, want)
	}

	// Jumping to January in Brussels starts after the late upload.
	page := decodeMediaPage(t, router, fmt.Sprintf("/api/v1/channels/%d/media?month=2026-01&tz=Europe/Brussels", ch), token)
	if len(page.Items) != 2 || page.Items[0].Attachment.Filename != "mid.png" {
		t.Errorf("January page = %+v", page)
	}
}

// Access is checked on every page: a cursor from before a role change does not
// keep the gallery open.
func TestChannelMedia_LostReadMidBrowseStopsPaging(t *testing.T) {
	database, router, svc := newMediaRouterWithServices(t)
	token := chTestCreateToken(t, database, "media-revoked", int(permissions.MemberRoleID))
	ch, _ := database.CreateChannel(context.Background(), "photos", "text", "", "", 0)
	postMedia(t, database, ch, "media-revoked", "2026-01-01 10:00:00", "a.png", "b.png")

	first := decodeMediaPage(t, router, fmt.Sprintf("/api/v1/channels/%d/media?limit=1", ch), token)
	if first.NextCursor == "" {
		t.Fatalf("first page has no cursor: %+v", first)
	}
	denyReadMessages(t, database, ch, permissions.MemberRoleID)
	svc.Permissions.InvalidateAll() // what the override write path does
	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/media?limit=1&cursor=%s", ch, first.NextCursor), token)
	if rr.Code != http.StatusForbidden {
		t.Errorf("second page after losing read = %d, want 403", rr.Code)
	}
}
