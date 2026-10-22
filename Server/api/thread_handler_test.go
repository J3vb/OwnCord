package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

func TestThreadList_PaginationArchivedAndGate(t *testing.T) {
	database := newChannelTestDB(t)
	ctx := context.Background()
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountThreadRoutes(r, svc)

	token := chTestCreateToken(t, database, "reader", 4)
	owner, err := database.CreateUser(ctx, "starter", "h", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 0, 3)
	for _, name := range []string{"a", "b", "c"} {
		res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'x')`, parent, owner)
		if err != nil {
			t.Fatal(err)
		}
		mid, _ := res.LastInsertId()
		info, _, err := database.CreateThread(ctx, db.NewThread{ParentID: parent, StarterMessageID: mid, OwnerID: owner, Name: name, AutoArchiveMinutes: 1440})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, info.ID)
		if _, err := database.ExecContext(ctx, `UPDATE channels SET thread_last_activity_at = ? WHERE id = ?`, time.Now().UTC().Add(time.Duration(len(ids))*time.Minute).Format("2006-01-02T15:04:05Z"), info.ID); err != nil {
			t.Fatal(err)
		}
	}
	archived := true
	if _, err := database.UpdateThread(ctx, ids[0], db.ThreadPatch{Archived: &archived}, true); err != nil {
		t.Fatal(err)
	}

	type page struct {
		Threads []db.ThreadInfo `json:"threads"`
		HasMore bool            `json:"has_more"`
		Next    string          `json:"next_before"`
	}
	get := func(path string) (int, page) {
		rr := chGet(t, r, path, token)
		var p page
		_ = json.NewDecoder(rr.Body).Decode(&p)
		return rr.Code, p
	}
	base := "/api/v1/channels/" + itoa(parent) + "/threads"
	code, p := get(base + "?limit=1")
	if code != 200 || len(p.Threads) != 1 || p.Threads[0].ID != ids[2] || !p.HasMore {
		t.Fatalf("page 1: %d %+v", code, p)
	}
	// Activity in the cursor thread between pages must not move the page.
	if _, err := database.ExecContext(ctx, `UPDATE channels SET thread_last_activity_at = '2000-01-01T00:00:00Z' WHERE id = ?`, ids[2]); err != nil {
		t.Fatal(err)
	}
	code, p = get(base + "?limit=1&before=" + p.Next)
	if code != 200 || len(p.Threads) != 1 || p.Threads[0].ID != ids[1] {
		t.Fatalf("page 2: %d %+v", code, p)
	}
	code, p = get(base + "?archived=1")
	if code != 200 || len(p.Threads) != 1 || p.Threads[0].ID != ids[0] {
		t.Fatalf("archived: %d %+v", code, p)
	}
	if code, _ = get(base + "?archived=2"); code != http.StatusBadRequest {
		t.Fatalf("bad archived = %d", code)
	}
	if code, _ = get(base + "?before=x"); code != http.StatusBadRequest {
		t.Fatalf("bad before = %d", code)
	}
	if rr := chGet(t, r, base, ""); rr.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d", rr.Code)
	}

	// The parent's read gate applies.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`, parent, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	svc.Permissions.InvalidateAll()
	if code, _ = get(base); code != http.StatusForbidden && code != http.StatusNotFound {
		t.Fatalf("gated list = %d, want 403/404", code)
	}
}
