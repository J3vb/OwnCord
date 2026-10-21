package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.5a: the category routes under mountChannelActionRoutes.

type categoryFixture struct {
	t        *testing.T
	database *db.DB
	handler  http.Handler
	hub      *mockHub
	admin    string
}

func newCategoryFixture(t *testing.T) *categoryFixture {
	t.Helper()
	database := openAdminTestDB(t)
	hub := &mockHub{}
	return &categoryFixture{
		t:        t,
		database: database,
		hub:      hub,
		handler:  admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database)),
		admin:    createAdminUser(t, database),
	}
}

func (f *categoryFixture) do(method, path string, body any) (int, []byte) {
	f.t.Helper()
	w := doRequest(f.t, f.handler, method, path, f.admin, body)
	return w.Code, w.Body.Bytes()
}

func (f *categoryFixture) mustCreate(name string) db.ChannelCategory {
	f.t.Helper()
	code, body := f.do(http.MethodPost, "/channels/categories", map[string]any{"name": name})
	if code != http.StatusCreated {
		f.t.Fatalf("create category %q: status %d, body %s", name, code, body)
	}
	var c db.ChannelCategory
	if err := json.Unmarshal(body, &c); err != nil {
		f.t.Fatalf("decode category: %v", err)
	}
	return c
}

func (f *categoryFixture) list() []db.ChannelCategory {
	f.t.Helper()
	code, body := f.do(http.MethodGet, "/channels/categories", nil)
	if code != http.StatusOK {
		f.t.Fatalf("list categories: status %d, body %s", code, body)
	}
	var cats []db.ChannelCategory
	if err := json.Unmarshal(body, &cats); err != nil {
		f.t.Fatalf("decode categories: %v", err)
	}
	return cats
}

func (f *categoryFixture) channel(id int64) *db.Channel {
	f.t.Helper()
	ch, err := f.database.GetChannel(context.Background(), id)
	if err != nil || ch == nil {
		f.t.Fatalf("GetChannel(%d): %v", id, err)
	}
	return ch
}

func (f *categoryFixture) mustCreateChannel(body map[string]any) db.Channel {
	f.t.Helper()
	code, raw := f.do(http.MethodPost, "/channels", body)
	if code != http.StatusCreated {
		f.t.Fatalf("create channel %v: status %d, body %s", body, code, raw)
	}
	var ch db.Channel
	if err := json.Unmarshal(raw, &ch); err != nil {
		f.t.Fatalf("decode channel: %v", err)
	}
	return ch
}

func categoryIDs(cats []db.ChannelCategory) []int64 {
	out := make([]int64, 0, len(cats))
	for _, c := range cats {
		out = append(out, c.ID)
	}
	return out
}

func TestCategories_RequireManageChannels(t *testing.T) {
	f := newCategoryFixture(t)
	member := createMemberUser(t, f.database)
	cat := f.mustCreate("Text")
	id := itoa(cat.ID)
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/channels/categories", nil},
		{http.MethodPost, "/channels/categories", map[string]any{"name": "X"}},
		{http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{cat.ID}}},
		{http.MethodPatch, "/channels/categories/" + id, map[string]any{"name": "Y"}},
		{http.MethodDelete, "/channels/categories/" + id, nil},
	} {
		w := doRequest(t, f.handler, tc.method, tc.path, member, tc.body)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s as a member: status %d, want 403", tc.method, tc.path, w.Code)
		}
	}
	if got := f.list(); len(got) != 1 || got[0].Name != "Text" {
		t.Fatalf("a refused request changed the categories: %+v", got)
	}
}

func TestCategories_CreateListAndDuplicate(t *testing.T) {
	f := newCategoryFixture(t)
	a := f.mustCreate("  Games  ")
	b := f.mustCreate("Voice")
	if a.Name != "Games" || a.Position != 0 || b.Position != 1 {
		t.Fatalf("created = %+v, %+v; want a trimmed name appended last", a, b)
	}
	if len(f.hub.categoryBroadcasts) != 2 {
		t.Fatalf("channel_categories broadcasts = %d, want one per create", len(f.hub.categoryBroadcasts))
	}

	code, body := f.do(http.MethodPost, "/channels/categories", map[string]any{"name": "gAMES"})
	if code != http.StatusConflict || !strings.Contains(string(body), "CATEGORY_NAME_TAKEN") {
		t.Fatalf("duplicate ignoring case: status %d, body %s; want 409 CATEGORY_NAME_TAKEN", code, body)
	}
	if code, _ := f.do(http.MethodPost, "/channels/categories", map[string]any{"name": "   "}); code != http.StatusBadRequest {
		t.Fatalf("blank name: status %d, want 400", code)
	}
	if code, _ := f.do(http.MethodPost, "/channels/categories", map[string]any{"name": strings.Repeat("x", 101)}); code != http.StatusBadRequest {
		t.Fatalf("101-rune name: status %d, want 400", code)
	}
	if got := f.list(); len(got) != 2 {
		t.Fatalf("list = %+v, want the two created", got)
	}
	if len(f.hub.categoryBroadcasts) != 2 {
		t.Fatalf("a refused create broadcast: %d broadcasts", len(f.hub.categoryBroadcasts))
	}
}

func TestCategories_RenameFollowsEveryChannel(t *testing.T) {
	f := newCategoryFixture(t)
	games := f.mustCreate("Games")
	other := f.mustCreate("Other")
	c1 := f.mustCreateChannel(map[string]any{"name": "one", "category_id": games.ID})
	c2 := f.mustCreateChannel(map[string]any{"name": "two", "type": "voice", "category_id": games.ID})
	loose := f.mustCreateChannel(map[string]any{"name": "loose"})
	f.hub.channelUpdates = nil
	f.hub.categoryBroadcasts = nil

	code, body := f.do(http.MethodPatch, "/channels/categories/"+itoa(games.ID), map[string]any{"name": "Play"})
	if code != http.StatusOK {
		t.Fatalf("rename: status %d, body %s", code, body)
	}
	for _, id := range []int64{c1.ID, c2.ID} {
		if ch := f.channel(id); ch.Category != "Play" || ch.CategoryID != games.ID {
			t.Errorf("channel %d = %q/%d, want Play/%d", id, ch.Category, ch.CategoryID, games.ID)
		}
	}
	if len(f.hub.channelUpdates) != 2 {
		t.Fatalf("channel_update broadcasts = %d, want one per channel in the category", len(f.hub.channelUpdates))
	}
	seen := map[int64]string{}
	for _, ch := range f.hub.channelUpdates {
		seen[ch.ID] = ch.Category
	}
	if seen[c1.ID] != "Play" || seen[c2.ID] != "Play" || len(seen) != 2 {
		t.Fatalf("channel updates = %v, want both channels carrying the new name and not %d", seen, loose.ID)
	}
	if len(f.hub.categoryBroadcasts) != 1 || f.hub.categoryBroadcasts[0][0].Name != "Play" {
		t.Fatalf("category broadcasts = %+v, want one carrying the renamed list", f.hub.categoryBroadcasts)
	}

	if code, body := f.do(http.MethodPatch, "/channels/categories/"+itoa(games.ID), map[string]any{"name": "OTHER"}); code != http.StatusConflict {
		t.Fatalf("rename onto %q: status %d, body %s; want 409", other.Name, code, body)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/categories/"+itoa(games.ID), map[string]any{"name": "PLAY"}); code != http.StatusOK {
		t.Fatalf("a case-only rename of itself: status %d, want 200", code)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/categories/9999", map[string]any{"name": "Nope"}); code != http.StatusNotFound {
		t.Fatalf("rename of a missing category: status %d, want 404", code)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/categories/abc", map[string]any{"name": "Nope"}); code != http.StatusBadRequest {
		t.Fatalf("rename of a non-numeric id: status %d, want 400", code)
	}
}

// Edge case 1 (design section 4): two managers reorder at once. The second PUT
// carries an id set that is stale, answers 409 and writes nothing.
func TestCategories_StaleReorderIs409AndWritesNothing(t *testing.T) {
	f := newCategoryFixture(t)
	a, b, c := f.mustCreate("A"), f.mustCreate("B"), f.mustCreate("C")
	ch := f.mustCreateChannel(map[string]any{"name": "in-c", "category_id": c.ID})

	code, body := f.do(http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{c.ID, a.ID, b.ID}})
	if code != http.StatusOK {
		t.Fatalf("first reorder: status %d, body %s", code, body)
	}
	if got := categoryIDs(f.list()); got[0] != c.ID || got[1] != a.ID || got[2] != b.ID {
		t.Fatalf("order after the first reorder = %v", got)
	}
	if got := f.channel(ch.ID).CategoryPosition; got != 0 {
		t.Fatalf("channel's category_position = %d, want 0 once its category is first", got)
	}
	if len(f.hub.channelUpdates) == 0 {
		t.Fatalf("reorder re-broadcast no channel_update for the channel whose category_position changed")
	}

	// Another manager adds a category in between; the second editor still
	// holds the three-id list.
	d := f.mustCreate("D")
	f.hub.channelUpdates = nil
	f.hub.categoryBroadcasts = nil
	code, body = f.do(http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{b.ID, a.ID, c.ID}})
	if code != http.StatusConflict || !strings.Contains(string(body), "CATEGORY_LIST_STALE") {
		t.Fatalf("stale reorder: status %d, body %s; want 409 CATEGORY_LIST_STALE", code, body)
	}
	if got := categoryIDs(f.list()); got[0] != c.ID || got[1] != a.ID || got[2] != b.ID || got[3] != d.ID {
		t.Fatalf("a refused reorder wrote: order is now %v", got)
	}
	if len(f.hub.channelUpdates) != 0 || len(f.hub.categoryBroadcasts) != 0 {
		t.Fatalf("a refused reorder broadcast: %d channel updates, %d category lists", len(f.hub.channelUpdates), len(f.hub.categoryBroadcasts))
	}

	// A set with an id that no longer exists is stale too.
	if code, _ := f.do(http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{a.ID, b.ID, c.ID, 9999}}); code != http.StatusConflict {
		t.Fatalf("reorder naming a missing id: status %d, want 409", code)
	}
	if code, _ := f.do(http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{a.ID, a.ID, b.ID, c.ID}}); code != http.StatusBadRequest {
		t.Fatalf("reorder repeating an id: status %d, want 400", code)
	}
	if code, _ := f.do(http.MethodPut, "/channels/categories/order", map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("reorder without ids: status %d, want 400", code)
	}
}

func TestCategories_DeleteLeavesChannelsUncategorized(t *testing.T) {
	f := newCategoryFixture(t)
	games := f.mustCreate("Games")
	keep := f.mustCreate("Keep")
	inGames := f.mustCreateChannel(map[string]any{"name": "arena", "category_id": games.ID})
	inKeep := f.mustCreateChannel(map[string]any{"name": "lounge", "category_id": keep.ID})
	f.hub.channelUpdates = nil

	if code, body := f.do(http.MethodDelete, "/channels/categories/"+itoa(games.ID), nil); code != http.StatusNoContent {
		t.Fatalf("delete: status %d, body %s", code, body)
	}
	got := f.channel(inGames.ID)
	if got.CategoryID != 0 || got.Category != "" || got.Name != "arena" {
		t.Fatalf("channel after its category was deleted = %+v, want it kept and uncategorized", got)
	}
	if f.channel(inKeep.ID).CategoryID != keep.ID {
		t.Fatalf("a channel in another category moved")
	}
	if len(f.hub.channelUpdates) != 1 || f.hub.channelUpdates[0].ID != inGames.ID || f.hub.channelUpdates[0].CategoryID != 0 {
		t.Fatalf("channel updates = %+v, want one for the channel that lost its category", f.hub.channelUpdates)
	}
	if n := len(f.hub.categoryBroadcasts); n == 0 || len(f.hub.categoryBroadcasts[n-1]) != 1 {
		t.Fatalf("category broadcasts = %+v, want the remaining list", f.hub.categoryBroadcasts)
	}
	if code, _ := f.do(http.MethodDelete, "/channels/categories/"+itoa(games.ID), nil); code != http.StatusNotFound {
		t.Fatalf("second delete: status %d, want 404", code)
	}
}

func TestCategories_EveryMutationIsAudited(t *testing.T) {
	f := newCategoryFixture(t)
	a := f.mustCreate("A")
	b := f.mustCreate("B")
	f.do(http.MethodPatch, "/channels/categories/"+itoa(a.ID), map[string]any{"name": "A2"})
	f.do(http.MethodPut, "/channels/categories/order", map[string]any{"ids": []int64{b.ID, a.ID}})
	f.do(http.MethodDelete, "/channels/categories/"+itoa(b.ID), nil)

	code, body := f.do(http.MethodGet, "/audit-log?limit=50", nil)
	if code != http.StatusOK {
		t.Fatalf("audit log: status %d", code)
	}
	for _, action := range []string{"category_create", "category_rename", "category_reorder", "category_delete"} {
		if !strings.Contains(string(body), action) {
			t.Errorf("audit log has no %s row: %s", action, body)
		}
	}
}

func TestChannelWrites_LegacyCategoryStringAndCategoryID(t *testing.T) {
	f := newCategoryFixture(t)

	// The legacy string creates the category when it is missing...
	first := f.mustCreateChannel(map[string]any{"name": "one", "category": "Games"})
	if first.Category != "Games" || first.CategoryID == 0 {
		t.Fatalf("legacy create = %+v, want a category named Games with an id", first)
	}
	// ...and resolves by name ignoring case when it exists, never a second row.
	second := f.mustCreateChannel(map[string]any{"name": "two", "category": "gAMES"})
	if second.CategoryID != first.CategoryID || second.Category != "Games" {
		t.Fatalf("legacy create by another spelling = %+v, want category %d (Games)", second, first.CategoryID)
	}
	if got := f.list(); len(got) != 1 {
		t.Fatalf("categories = %+v, want one", got)
	}

	// category_id wins over the string.
	other := f.mustCreate("Other")
	both := f.mustCreateChannel(map[string]any{"name": "three", "category": "Games", "category_id": other.ID})
	if both.CategoryID != other.ID || both.Category != "Other" {
		t.Fatalf("both sent = %+v, want category_id to win", both)
	}
	if got := f.list(); len(got) != 2 {
		t.Fatalf("categories = %+v, want the string not to have created anything", got)
	}

	// An unknown id is refused and creates nothing.
	if code, _ := f.do(http.MethodPost, "/channels", map[string]any{"name": "x", "category_id": 9999}); code != http.StatusBadRequest {
		t.Fatalf("unknown category_id on create: status %d, want 400", code)
	}
	if code, _ := f.do(http.MethodPost, "/channels", map[string]any{"name": "x", "category_id": -1}); code != http.StatusBadRequest {
		t.Fatalf("negative category_id on create: status %d, want 400", code)
	}

	// PATCH: nothing named leaves the category alone.
	if code, body := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"topic": "t"}); code != http.StatusOK {
		t.Fatalf("patch topic: status %d, body %s", code, body)
	}
	if got := f.channel(first.ID); got.CategoryID != first.CategoryID {
		t.Fatalf("a patch that named no category moved the channel: %+v", got)
	}
	// category_id moves it (and 0 means none).
	if code, body := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"category_id": other.ID}); code != http.StatusOK {
		t.Fatalf("patch category_id: status %d, body %s", code, body)
	}
	if got := f.channel(first.ID); got.CategoryID != other.ID {
		t.Fatalf("category_id patch = %+v", got)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"category_id": 0}); code != http.StatusOK {
		t.Fatalf("patch category_id 0: status %d", code)
	}
	if got := f.channel(first.ID); got.CategoryID != 0 || got.Category != "" {
		t.Fatalf("category_id 0 = %+v, want uncategorized", got)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"category_id": 9999}); code != http.StatusBadRequest {
		t.Fatalf("unknown category_id on patch: status %d, want 400", code)
	}
	// The legacy string on PATCH: by name, creating when new, empty clears.
	if code, body := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"category": "Brand New"}); code != http.StatusOK {
		t.Fatalf("patch legacy category: status %d, body %s", code, body)
	}
	if got := f.channel(first.ID); got.Category != "Brand New" || got.CategoryID == 0 {
		t.Fatalf("legacy patch = %+v, want the new category", got)
	}
	if code, _ := f.do(http.MethodPatch, "/channels/"+itoa(first.ID), map[string]any{"category": ""}); code != http.StatusOK {
		t.Fatalf("patch empty category: status %d", code)
	}
	if got := f.channel(first.ID); got.CategoryID != 0 {
		t.Fatalf("empty legacy category = %+v, want none", got)
	}
}

func TestChannelWrites_NameUniquePerTypeAndCategoryID(t *testing.T) {
	f := newCategoryFixture(t)
	a, b := f.mustCreate("A"), f.mustCreate("B")
	f.mustCreateChannel(map[string]any{"name": "lobby", "category_id": a.ID})

	if code, _ := f.do(http.MethodPost, "/channels", map[string]any{"name": "LOBBY", "category_id": a.ID}); code != http.StatusConflict {
		t.Fatalf("same name, same category id: status %d, want 409", code)
	}
	if code, _ := f.do(http.MethodPost, "/channels", map[string]any{"name": "lobby", "category": "a"}); code != http.StatusConflict {
		t.Fatalf("same name, same category by another spelling: status %d, want 409", code)
	}
	f.mustCreateChannel(map[string]any{"name": "lobby", "category_id": b.ID})
	f.mustCreateChannel(map[string]any{"name": "lobby"})
	f.mustCreateChannel(map[string]any{"name": "lobby", "type": "voice", "category_id": a.ID})
}

// Edge case 2 (design section 4): a rename racing a channel create in the same
// category lands the create on the one category row, under the new name.
func TestCategories_RenameRacingChannelCreate(t *testing.T) {
	f := newCategoryFixture(t)
	games := f.mustCreate("Games")
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 5 {
			f.do(http.MethodPatch, "/channels/categories/"+itoa(games.ID), map[string]any{"name": []string{"Play", "Games"}[i%2]})
		}
	}()
	created := make([]db.Channel, 0, 5)
	for _, name := range []string{"c1", "c2", "c3", "c4", "c5"} {
		created = append(created, f.mustCreateChannel(map[string]any{"name": name, "category_id": games.ID}))
	}
	<-done
	cats := f.list()
	if len(cats) != 1 {
		t.Fatalf("categories = %+v, want the one row", cats)
	}
	for _, ch := range created {
		got := f.channel(ch.ID)
		if got.CategoryID != games.ID || got.Category != cats[0].Name {
			t.Errorf("channel %q = %q/%d, want the one category %q/%d", ch.Name, got.Category, got.CategoryID, cats[0].Name, games.ID)
		}
	}
}
