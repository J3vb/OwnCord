package api_test

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// withReplyPing adds the reply_ping column (migration 060) that the hand-rolled
// channel test schema predates, without touching the shared helper.
func withReplyPing(t *testing.T, f *searchFixture) *searchFixture {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(),
		`ALTER TABLE message_mentions ADD COLUMN reply_ping INTEGER NOT NULL DEFAULT 0`); err != nil {
		t.Fatalf("add reply_ping: %v", err)
	}
	return f
}

func TestSearch_HasMentionsPinned(t *testing.T) {
	ctx := context.Background()
	f := withReplyPing(t, newSearchFixture(t, "hmp"))
	ch := f.channel(t, "main", 0)
	plain := f.say(t, ch, f.owner.ID, "plain words")
	linked := f.say(t, ch, f.owner.ID, "docs at https://example.com/x")
	m, err := f.database.CreateMessageWithMentions(ctx, ch, f.owner.ID, "hey member", nil, []int64{f.member.ID}, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.database.SetMessagePinned(ctx, plain, true); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		q    string
		want []int64
	}{
		{"has:link", []int64{linked}},
		{"mentions:@" + f.member.Username, []int64{m.ID}},
		{"mentions:" + strings.ToUpper(f.member.Username), []int64{m.ID}},
		{"mentions:nobody-here", nil},
		{"mentions:" + f.member.Username + " mentions:nobody-here", nil},
		{"pinned:true", []int64{plain}},
		{"pinned:false", []int64{m.ID, linked}},
		{"pinned:true pinned:false", nil},
	}
	for _, tc := range cases {
		code, body, parsed := f.search(t, f.memberTok, tc.q)
		if code != http.StatusOK {
			t.Fatalf("%q: code %d body %s", tc.q, code, body)
		}
		if got := ids(parsed); !slices.Equal(got, tc.want) && (len(got) != 0 || len(tc.want) != 0) {
			t.Errorf("%q = %v, want %v", tc.q, got, tc.want)
		}
	}
}

func TestSearch_BadHasAndPinned400(t *testing.T) {
	f := newSearchFixture(t, "bhp")
	f.channel(t, "main", 0)
	for q, name := range map[string]string{"has:embed": "has:", "has:poll x": "has:", "pinned:maybe": "pinned:"} {
		code, body, _ := f.search(t, f.memberTok, q)
		if code != http.StatusBadRequest || !strings.Contains(body, name) {
			t.Errorf("%q: code %d body %s, want 400 naming %s", q, code, body, name)
		}
	}
}

// has:, mentions: and pinned: narrow the readable set; they never widen it.
func TestSearch_HasMentionsPinnedNeverLeakUnreadable(t *testing.T) {
	ctx := context.Background()
	f := withReplyPing(t, newSearchFixture(t, "hmpl"))
	secret := f.channel(t, "secret", 0)
	denyReadMessages(t, f.database, secret, permissions.MemberRoleID)
	hit, err := f.database.CreateMessageWithMentions(ctx, secret, f.owner.ID, "see https://example.com @member", nil, []int64{f.member.ID}, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.database.SetMessagePinned(ctx, hit.ID, true); err != nil {
		t.Fatal(err)
	}
	queries := []string{"has:link", "mentions:" + f.member.Username, "pinned:true", "has:link pinned:true mentions:" + f.member.Username, "in:secret has:link"}
	for _, q := range queries {
		code, body, parsed := f.search(t, f.memberTok, q)
		if code != http.StatusOK || len(parsed.Results) != 0 {
			t.Errorf("member %q: code %d body %s, want empty 200", q, code, body)
		}
		code, _, parsed = f.search(t, f.ownerTok, q)
		if code != http.StatusOK || len(parsed.Results) != 1 {
			t.Errorf("owner %q: code %d results %d, want 1", q, code, len(parsed.Results))
		}
	}
}
