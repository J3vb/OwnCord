package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// searchFixture is a small server for filter tests: an owner who wrote every
// message and a plain member who searches.
type searchFixture struct {
	database  *db.DB
	router    http.Handler
	owner     *db.User
	member    *db.User
	ownerTok  string
	memberTok string
}

func newSearchFixture(t *testing.T, tag string) *searchFixture {
	t.Helper()
	database := newChannelTestDB(t)
	f := &searchFixture{database: database, router: buildChannelRouter(database)}
	f.ownerTok = chTestCreateToken(t, database, tag+"-owner", 1)
	f.memberTok = chTestCreateToken(t, database, tag+"-member", 4)
	f.owner, _ = database.GetUserByUsername(context.Background(), tag+"-owner")
	f.member, _ = database.GetUserByUsername(context.Background(), tag+"-member")
	return f
}

func (f *searchFixture) channel(t *testing.T, name string, pos int) int64 {
	t.Helper()
	id, err := f.database.CreateChannel(context.Background(), name, "text", "", "", pos)
	if err != nil {
		t.Fatalf("CreateChannel(%q): %v", name, err)
	}
	return id
}

func (f *searchFixture) say(t *testing.T, ch, user int64, content string) int64 {
	t.Helper()
	id, err := f.database.CreateMessage(context.Background(), ch, user, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return id
}

type searchBody struct {
	Results []struct {
		MessageID int64 `json:"message_id"`
	} `json:"results"`
	NextBefore *int64 `json:"next_before"`
}

func (f *searchFixture) search(t *testing.T, tok, query string, extra ...string) (int, string, searchBody) {
	t.Helper()
	path := "/api/v1/search?q=" + url.QueryEscape(query)
	for _, e := range extra {
		path += "&" + e
	}
	rr := chGet(t, f.router, path, tok)
	var body searchBody
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	return rr.Code, rr.Body.String(), body
}

func ids(b searchBody) []int64 {
	out := make([]int64, len(b.Results))
	for i, r := range b.Results {
		out[i] = r.MessageID
	}
	return out
}

// Edge case 1: an in: target the caller cannot read is exactly a name that
// matches nothing, alone and combined with channel_id.
func TestSearch_InUnreadableTargetsLookIdentical(t *testing.T) {
	ctx := context.Background()
	f := newSearchFixture(t, "inid")
	pub := f.channel(t, "pub", 0)
	secret := f.channel(t, "secret", 1)
	adult := f.channel(t, "adult", 2)
	denyReadMessages(t, f.database, secret, permissions.MemberRoleID)
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, adult); err != nil {
		t.Fatal(err)
	}
	_ = chTestCreateToken(t, f.database, "inid-third", 4)
	thirdUser, _ := f.database.GetUserByUsername(ctx, "inid-third")
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, f.owner.ID, thirdUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range []int64{pub, secret, adult, dm.ID} {
		f.say(t, ch, f.owner.ID, "needle everywhere")
	}

	var dmName string
	if err := f.database.QueryRowContext(ctx, `SELECT name FROM channels WHERE id = ?`, dm.ID).Scan(&dmName); err != nil {
		t.Fatal(err)
	}
	targets := []string{"secret", "adult", "nope-nothing"}
	if dmName != "" {
		targets = append(targets, strings.ReplaceAll(dmName, `"`, ""))
	}
	for _, extra := range [][]string{nil, {fmt.Sprintf("channel_id=%d", pub)}} {
		var wantCode int
		var wantBody string
		for i, name := range targets {
			code, body, parsed := f.search(t, f.memberTok, `needle in:"`+name+`"`, extra...)
			if code != http.StatusOK || len(parsed.Results) != 0 {
				t.Fatalf("in:%s extra=%v: code %d body %s, want empty 200", name, extra, code, body)
			}
			if i == 0 {
				wantCode, wantBody = code, body
				continue
			}
			if code != wantCode || body != wantBody {
				t.Errorf("in:%s extra=%v differs from in:%s: %q vs %q", name, extra, targets[0], body, wantBody)
			}
		}
	}
	// The readable target still works, so the empty answers above are not a dead filter.
	if _, _, parsed := f.search(t, f.memberTok, "needle in:pub"); len(parsed.Results) != 1 {
		t.Errorf("in:pub results = %d, want 1", len(parsed.Results))
	}
	// An admin's readable set still decides, and it includes the private channel.
	if _, _, parsed := f.search(t, f.ownerTok, "needle in:secret"); len(parsed.Results) != 1 {
		t.Errorf("admin in:secret results = %d, want 1", len(parsed.Results))
	}
}

func TestSearch_InFansOutToSameNameOnlyReadable(t *testing.T) {
	f := newSearchFixture(t, "fan")
	g1 := f.channel(t, "general", 0)
	g2 := f.channel(t, "General", 1)
	g3 := f.channel(t, "general", 2)
	other := f.channel(t, "random", 3)
	denyReadMessages(t, f.database, g3, permissions.MemberRoleID)
	m1 := f.say(t, g1, f.owner.ID, "needle one")
	m2 := f.say(t, g2, f.owner.ID, "needle two")
	f.say(t, g3, f.owner.ID, "needle hidden")
	f.say(t, other, f.owner.ID, "needle other")

	_, _, parsed := f.search(t, f.memberTok, "needle in:#general", "sort=recent")
	if got, want := ids(parsed), []int64{m2, m1}; !slices.Equal(got, want) {
		t.Errorf("ids = %v, want %v", got, want)
	}
}

func TestSearch_InWithChannelIDIntersects(t *testing.T) {
	f := newSearchFixture(t, "inx")
	a := f.channel(t, "alpha", 0)
	b := f.channel(t, "beta", 1)
	ma := f.say(t, a, f.owner.ID, "needle a")
	f.say(t, b, f.owner.ID, "needle b")
	if _, _, p := f.search(t, f.memberTok, "needle in:alpha", fmt.Sprintf("channel_id=%d", a)); !slices.Equal(ids(p), []int64{ma}) {
		t.Errorf("same channel: ids = %v", ids(p))
	}
	if _, _, p := f.search(t, f.memberTok, "needle in:beta", fmt.Sprintf("channel_id=%d", a)); len(p.Results) != 0 {
		t.Errorf("disjoint: ids = %v, want none", ids(p))
	}
}

func TestSearch_FromUnknownUserEmpty(t *testing.T) {
	f := newSearchFixture(t, "unk")
	ch := f.channel(t, "c", 0)
	f.say(t, ch, f.owner.ID, "needle")
	code, body, p := f.search(t, f.memberTok, "needle from:nobody-here")
	if code != http.StatusOK || len(p.Results) != 0 {
		t.Errorf("code %d body %s, want empty 200", code, body)
	}
	if _, _, p := f.search(t, f.memberTok, "needle from:@UNK-OWNER"); len(p.Results) != 1 {
		t.Errorf("from:@UNK-OWNER (case-insensitive, @) results = %d, want 1", len(p.Results))
	}
}

// Edge case 2: filter-only queries are newest first and page cleanly; the
// follow-up page keeps filters and scope.
func TestSearch_FilterOnlyPagesNewestFirst(t *testing.T) {
	f := newSearchFixture(t, "fo")
	pub := f.channel(t, "pub", 0)
	hidden := f.channel(t, "hidden", 1)
	denyReadMessages(t, f.database, hidden, permissions.MemberRoleID)

	var want []int64
	for i := range 5 {
		id := f.say(t, pub, f.owner.ID, fmt.Sprintf("mine %d", i))
		want = append([]int64{id}, want...)
		f.say(t, pub, f.member.ID, "not owner")
		f.say(t, hidden, f.owner.ID, "unreadable owner")
	}

	var got []int64
	q := "from:fo-owner"
	extra := []string{"limit=2"} // note: no sort; filter-only forces newest first
	for range 10 {
		code, body, p := f.search(t, f.memberTok, q, extra...)
		if code != http.StatusOK {
			t.Fatalf("code %d: %s", code, body)
		}
		got = append(got, ids(p)...)
		if p.NextBefore == nil {
			break
		}
		extra = []string{"limit=2", "sort=recent", fmt.Sprintf("before=%d", *p.NextBefore)}
	}
	if !slices.Equal(got, want) {
		t.Errorf("paged ids = %v, want %v", got, want)
	}

	// before without sort=recent is still refused for the cursor contract.
	if code, _, _ := f.search(t, f.memberTok, q, "before=5"); code != http.StatusBadRequest {
		t.Errorf("before without sort=recent: code %d, want 400", code)
	}
}

func TestSearch_TZShiftsDayBoundary(t *testing.T) {
	ctx := context.Background()
	f := newSearchFixture(t, "tz")
	ch := f.channel(t, "c", 0)
	id := f.say(t, ch, f.owner.ID, "late night")
	if _, err := f.database.ExecContext(ctx, `UPDATE messages SET timestamp = '2026-01-14 23:30:00' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if _, _, p := f.search(t, f.memberTok, "during:2026-01-14"); len(p.Results) != 1 {
		t.Errorf("UTC during:01-14 results = %d, want 1", len(p.Results))
	}
	if _, _, p := f.search(t, f.memberTok, "during:2026-01-15", "tz=Europe/Amsterdam"); len(p.Results) != 1 {
		t.Errorf("Amsterdam during:01-15 results = %d, want 1", len(p.Results))
	}
	if _, _, p := f.search(t, f.memberTok, "during:2026-01-14", "tz=Europe/Amsterdam"); len(p.Results) != 0 {
		t.Errorf("Amsterdam during:01-14 results = %d, want 0", len(p.Results))
	}
	if _, _, p := f.search(t, f.memberTok, "after:2026-01-13 before:2026-01-15"); len(p.Results) != 1 {
		t.Errorf("after/before window results = %d, want 1", len(p.Results))
	}
}

func TestSearch_BadFilterValue400(t *testing.T) {
	f := newSearchFixture(t, "bad")
	code, body, _ := f.search(t, f.memberTok, "hi before:2026-02-30")
	if code != http.StatusBadRequest || !strings.Contains(body, "BAD_REQUEST") || !strings.Contains(body, "before:") {
		t.Errorf("code %d body %s, want 400 BAD_REQUEST naming before:", code, body)
	}
}

func TestSearch_InvalidTZ400(t *testing.T) {
	f := newSearchFixture(t, "badtz")
	code, body, _ := f.search(t, f.memberTok, "hi", "tz=Mars/Base")
	if code != http.StatusBadRequest || !strings.Contains(body, "tz") {
		t.Errorf("code %d body %s, want 400 naming tz", code, body)
	}
}

func TestSearch_FromValueInert(t *testing.T) {
	f := newSearchFixture(t, "inert")
	ch := f.channel(t, "c", 0)
	f.say(t, ch, f.owner.ID, "needle")
	code, body, p := f.search(t, f.memberTok, `from:"x' OR 1=1 --"`)
	if code != http.StatusOK || len(p.Results) != 0 {
		t.Errorf("code %d body %s, want empty 200", code, body)
	}
}
