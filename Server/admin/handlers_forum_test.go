package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.9d-a1: PUT /channels/{id}/forum under mountChannelActionRoutes.

func newForumHandlerFixture(t *testing.T) (*categoryFixture, int64) {
	t.Helper()
	database := openMigratedAdminDB(t)
	hub := &mockHub{}
	f := &categoryFixture{
		t:        t,
		database: database,
		hub:      hub,
		handler:  admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database)),
		admin:    createAdminUser(t, database),
	}
	ch := f.mustCreateChannel(map[string]any{"name": "ideas", "type": "forum"})
	return f, ch.ID
}

func (f *categoryFixture) putForum(id int64, body any) (int, []byte) {
	f.t.Helper()
	return f.do(http.MethodPut, "/channels/"+itoa(id)+"/forum", body)
}

func TestForumSettings_FullReplace(t *testing.T) {
	f, id := newForumHandlerFixture(t)

	code, raw := f.putForum(id, map[string]any{
		"require_tag":                  true,
		"default_auto_archive_minutes": 1440,
		"tags":                         []map[string]any{{"name": "bug", "emoji": "🐛"}, {"name": "idea"}},
	})
	if code != http.StatusOK {
		t.Fatalf("status %d, body %s", code, raw)
	}
	var ch db.Channel
	if err := json.Unmarshal(raw, &ch); err != nil {
		t.Fatal(err)
	}
	if ch.Forum == nil || !ch.Forum.RequireTag || ch.Forum.DefaultAutoArchiveMinutes != 1440 || len(ch.Forum.Tags) != 2 ||
		ch.Forum.Tags[0].Name != "bug" || ch.Forum.Tags[0].Emoji != "🐛" || ch.Forum.Tags[1].Position != 1 {
		t.Fatalf("response forum = %+v", ch.Forum)
	}
	bug, idea := ch.Forum.Tags[0].ID, ch.Forum.Tags[1].ID

	// Full replace: rename keeps the id, a new tag is created, "idea" is omitted so it goes.
	code, raw = f.putForum(id, map[string]any{
		"default_auto_archive_minutes": 4320,
		"tags":                         []map[string]any{{"name": "feature"}, {"id": bug, "name": "defect"}},
	})
	if code != http.StatusOK {
		t.Fatalf("replace: status %d, body %s", code, raw)
	}
	got := f.channel(id).Forum
	if got.RequireTag || got.DefaultAutoArchiveMinutes != 4320 || len(got.Tags) != 2 ||
		got.Tags[0].Name != "feature" || got.Tags[1].ID != bug || got.Tags[1].Name != "defect" {
		t.Fatalf("stored forum = %+v", got)
	}
	for _, tg := range got.Tags {
		if tg.ID == idea {
			t.Error("a tag omitted from the list survived")
		}
	}

	// One channel_update per write, none for the refusals below.
	if n := len(f.hub.channelUpdates); n != 2 {
		t.Fatalf("%d channel_update broadcasts, want 2", n)
	}
	if last := f.hub.channelUpdates[1]; last.ID != id || last.Forum == nil || len(last.Forum.Tags) != 2 {
		t.Errorf("broadcast channel = %+v", last)
	}
	entries, err := f.database.GetAuditLog(context.Background(), 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if e.Action == "channel_update" && e.TargetID == id {
			n++
		}
	}
	if n != 2 {
		t.Errorf("%d audit rows for the two writes, want 2", n)
	}
}

func TestForumSettings_Refusals(t *testing.T) {
	f, id := newForumHandlerFixture(t)
	text := f.mustCreateChannel(map[string]any{"name": "general", "type": "text"})
	if code, raw := f.putForum(id, map[string]any{"default_auto_archive_minutes": 60, "tags": []map[string]any{{"name": "keep"}}}); code != http.StatusOK {
		t.Fatalf("seed: %d %s", code, raw)
	}
	updates := len(f.hub.channelUpdates)

	cases := map[string]struct {
		id   int64
		body any
	}{
		"bad archive period":  {id, map[string]any{"default_auto_archive_minutes": 7}},
		"missing period":      {id, map[string]any{"tags": []map[string]any{{"name": "x"}}}},
		"duplicate names":     {id, map[string]any{"default_auto_archive_minutes": 60, "tags": []map[string]any{{"name": "a"}, {"name": "A"}}}},
		"unknown tag id":      {id, map[string]any{"default_auto_archive_minutes": 60, "tags": []map[string]any{{"id": 9999, "name": "a"}}}},
		"a text channel":      {text.ID, map[string]any{"default_auto_archive_minutes": 60}},
		"not a json object":   {id, []int{1}},
		"empty tag name":      {id, map[string]any{"default_auto_archive_minutes": 60, "tags": []map[string]any{{"name": "  "}}}},
		"a channel that isnt": {9999, map[string]any{"default_auto_archive_minutes": 60}},
	}
	for name, c := range cases {
		code, raw := f.putForum(c.id, c.body)
		want := http.StatusBadRequest
		if name == "a channel that isnt" {
			want = http.StatusNotFound
		}
		if code != want {
			t.Errorf("%s: status %d, want %d; body %s", name, code, want, raw)
		}
	}
	if got := f.channel(id).Forum; len(got.Tags) != 1 || got.Tags[0].Name != "keep" || got.DefaultAutoArchiveMinutes != 60 {
		t.Errorf("a refused write changed the forum: %+v", got)
	}
	if len(f.hub.channelUpdates) != updates {
		t.Error("a refused write was broadcast")
	}
}

func TestForumSettings_RequireManageChannels(t *testing.T) {
	f, id := newForumHandlerFixture(t)
	_, member := sessionFor(t, f.database, "plainmember", 4)
	w := doRequest(t, f.handler, http.MethodPut, "/channels/"+itoa(id)+"/forum", member,
		map[string]any{"default_auto_archive_minutes": 60, "tags": []map[string]any{{"name": "x"}}})
	if w.Code != http.StatusForbidden {
		t.Errorf("a member: status %d, want 403", w.Code)
	}
	if got := f.channel(id).Forum; len(got.Tags) != 0 {
		t.Errorf("a refused request changed the forum: %+v", got)
	}
}

// The same handler is mounted for the desktop client under
// /api/v1/moderation/channels (NewChannelAPI).
func TestForumSettings_ServedOnTheClientMount(t *testing.T) {
	f, id := newForumHandlerFixture(t)
	handler := admin.NewChannelAPI(newTestServices(f.database), f.hub)
	w := doRequest(t, handler, http.MethodPut, "/"+itoa(id)+"/forum", f.admin,
		map[string]any{"default_auto_archive_minutes": 10080, "require_tag": true, "tags": []map[string]any{{"name": "x"}}})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", w.Code, w.Body.String())
	}
	if got := f.channel(id).Forum; !got.RequireTag || got.DefaultAutoArchiveMinutes != 10080 || len(got.Tags) != 1 {
		t.Errorf("stored forum = %+v", got)
	}
}
