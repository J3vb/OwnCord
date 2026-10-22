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

type forumListPage struct {
	Threads []db.ThreadInfo `json:"threads"`
	HasMore bool            `json:"has_more"`
	Next    string          `json:"next_before"`
}

func forumListSetup(t *testing.T) (r chi.Router, token string, forum int64, tags []db.ForumTag, posts []int64, database *db.DB) {
	t.Helper()
	database = newChannelTestDB(t)
	ctx := context.Background()
	r = chi.NewRouter()
	api.MountThreadRoutes(r, service.New(database, auth.NewRateLimiter()))
	token = chTestCreateToken(t, database, "reader", 4)
	owner, err := database.CreateUser(ctx, "poster", "h", 4)
	if err != nil {
		t.Fatal(err)
	}
	if forum, err = database.CreateChannel(ctx, "ideas", "forum", "", "", 0); err != nil {
		t.Fatal(err)
	}
	if tags, err = database.ReplaceForumSettings(ctx, forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 4320, Tags: []db.ForumTagWrite{{Name: "bug"}, {Name: "ask"}},
	}); err != nil {
		t.Fatal(err)
	}
	// Four posts; the last three share one activity second, so only id orders them.
	for i := range 4 {
		res, err := database.ExecContext(ctx,
			`INSERT INTO channels (name, type, parent_channel_id, thread_owner_id, thread_last_activity_at)
			 VALUES ('post', 'thread', ?, ?, ?)`,
			forum, owner, map[bool]string{true: "2026-01-01T00:00:00Z", false: "2026-02-02T02:02:02Z"}[i == 0])
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		posts = append(posts, id)
		if i%2 == 0 {
			if _, err := database.ExecContext(ctx, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, id, tags[0].ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	return r, token, forum, tags, posts, database
}

func TestThreadList_ForumSortTagAndPaging(t *testing.T) {
	r, token, forum, tags, posts, _ := forumListSetup(t)
	base := "/api/v1/channels/" + itoa(forum) + "/threads"
	get := func(q string) (int, forumListPage) {
		rr := chGet(t, r, base+q, token)
		var p forumListPage
		_ = json.NewDecoder(rr.Body).Decode(&p)
		return rr.Code, p
	}
	ids := func(p forumListPage) []int64 {
		out := make([]int64, 0, len(p.Threads))
		for _, th := range p.Threads {
			out = append(out, th.ID)
		}
		return out
	}
	want := func(t *testing.T, label string, got []int64, exp ...int64) {
		t.Helper()
		if len(got) != len(exp) {
			t.Fatalf("%s = %v, want %v", label, got, exp)
		}
		for i := range got {
			if got[i] != exp[i] {
				t.Fatalf("%s = %v, want %v", label, got, exp)
			}
		}
	}
	// Default is activity: the three tied posts by id DESC, the old one last.
	code, p := get("")
	want(t, "default", ids(p), posts[3], posts[2], posts[1], posts[0])
	if code != 200 || p.Threads[0].Post == nil {
		t.Fatalf("default: %d post block %+v", code, p.Threads[0].Post)
	}
	_, p = get("?sort=created")
	want(t, "created", ids(p), posts[3], posts[2], posts[1], posts[0])
	_, p = get("?tag=" + itoa(tags[0].ID))
	want(t, "tag bug", ids(p), posts[2], posts[0])
	_, p = get("?tag=" + itoa(tags[1].ID) + "&tag=" + itoa(tags[0].ID) + "&sort=created")
	want(t, "any-of created", ids(p), posts[2], posts[0])

	// Edge case 2: paging across identical activity seconds, in both sorts,
	// walks every post exactly once.
	for _, sort := range []string{"activity", "created"} {
		var got []int64
		cursor := ""
		for range 6 {
			_, pg := get("?limit=1&sort=" + sort + cursor)
			got = append(got, ids(pg)...)
			if !pg.HasMore {
				break
			}
			cursor = "&before=" + pg.Next
		}
		want(t, "paged "+sort, got, posts[3], posts[2], posts[1], posts[0])
	}
}

func TestThreadList_ForumParamErrors(t *testing.T) {
	r, token, forum, _, posts, database := forumListSetup(t)
	base := "/api/v1/channels/" + itoa(forum) + "/threads"
	other, err := database.CreateChannel(context.Background(), "other", "forum", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := database.ReplaceForumSettings(context.Background(), other, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 4320, Tags: []db.ForumTagWrite{{Name: "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	// The activity cursor and the created cursor are not interchangeable.
	actCursor := service.FormatThreadCursorFor("activity", db.ThreadCursor{Activity: "2026-02-02T02:02:02Z", ID: posts[3]})
	for name, q := range map[string]string{
		"unknown sort":               "?sort=hot",
		"tag not in forum":           "?tag=" + itoa(foreign[0].ID),
		"unknown tag":                "?tag=987654",
		"tag not numeric":            "?tag=bug",
		"tag zero":                   "?tag=0",
		"too many tags":              "?tag=1&tag=2&tag=3&tag=4&tag=5&tag=6",
		"bad cursor":                 "?before=garbage",
		"activity cursor on created": "?sort=created&before=" + actCursor,
		"created cursor on activity": "?before=" + itoa(posts[2]),
	} {
		rr := chGet(t, r, base+q, token)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: %s = %d, want 400", name, q, rr.Code)
		}
	}
}

// A text-channel parent lists as before; sort is accepted, a tag filter is not.
func TestThreadList_TextParentKeepsBehaviour(t *testing.T) {
	database := newChannelTestDB(t)
	ctx := context.Background()
	r := chi.NewRouter()
	api.MountThreadRoutes(r, service.New(database, auth.NewRateLimiter()))
	token := chTestCreateToken(t, database, "reader", 4)
	owner, _ := database.CreateUser(ctx, "starter", "h", 4)
	parent, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	res, _ := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'x')`, parent, owner)
	mid, _ := res.LastInsertId()
	info, _, err := database.CreateThread(ctx, db.NewThread{ParentID: parent, StarterMessageID: mid, OwnerID: owner, Name: "t", AutoArchiveMinutes: 1440})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/channels/" + itoa(parent) + "/threads"
	var p forumListPage
	rr := chGet(t, r, base, token)
	_ = json.NewDecoder(rr.Body).Decode(&p)
	if rr.Code != 200 || len(p.Threads) != 1 || p.Threads[0].ID != info.ID || p.Threads[0].Post != nil {
		t.Fatalf("text list = %d %+v", rr.Code, p)
	}
	if rr := chGet(t, r, base+"?tag=1", token); rr.Code != http.StatusBadRequest {
		t.Fatalf("tag on text parent = %d, want 400", rr.Code)
	}
}
