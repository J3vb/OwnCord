package service

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const devsRoleID int64 = 7

// seedPingRole adds role devsRoleID ("devs") held by the given users on top of
// whatever they already hold, flagged mentionable or not.
func seedPingRole(t *testing.T, database *db.DB, mentionable bool, holders ...int64) {
	t.Helper()
	ctx := context.Background()
	seedRole(t, database, &db.Role{
		ID: devsRoleID, Name: "devs",
		Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 5,
	})
	if _, err := database.ExecContext(ctx,
		`UPDATE roles SET mentionable = ? WHERE id = ?`, mentionable, devsRoleID); err != nil {
		t.Fatalf("flag mentionable: %v", err)
	}
	for _, uid := range holders {
		if _, err := database.ExecContext(ctx,
			`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, uid, devsRoleID); err != nil {
			t.Fatalf("grant devs to %d: %v", uid, err)
		}
	}
}

func TestParseMentionTokens_IDForms(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		wantUsers []int64
		wantRoles []int64
		wantNames []string
	}{
		{name: "user id", content: "hi <@7>", wantUsers: []int64{7}},
		{name: "role id", content: "hi <@&3>", wantRoles: []int64{3}},
		{name: "both and a name", content: "<@&3> <@7> @bob", wantUsers: []int64{7}, wantRoles: []int64{3}, wantNames: []string{"bob"}},
		{name: "deduplicated", content: "<@7><@7> <@&3> <@&3>", wantUsers: []int64{7}, wantRoles: []int64{3}},
		{name: "id is not read as a username", content: "<@7>", wantNames: nil, wantUsers: []int64{7}},
		{name: "zero id ignored", content: "<@0> <@&0>"},
		{name: "overflowing id is only a legacy name", content: "<@12345678901234567890>", wantNames: []string{"12345678901234567890"}},
		{name: "unclosed token is a legacy name", content: "<@7", wantNames: []string{"7"}},
		{name: "ampersand with a name is not a role", content: "<@&bob>"},
		{name: "role before name keeps order", content: "x<@&9>y @a @b", wantRoles: []int64{9}, wantNames: []string{"a", "b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseMentionTokens(tt.content)
			var names []string
			for _, tok := range got.Tokens {
				names = append(names, tok.spellings[0])
			}
			if !slices.Equal(got.UserIDs, tt.wantUsers) {
				t.Errorf("user ids = %v, want %v", got.UserIDs, tt.wantUsers)
			}
			if !slices.Equal(got.RoleIDs, tt.wantRoles) {
				t.Errorf("role ids = %v, want %v", got.RoleIDs, tt.wantRoles)
			}
			if !slices.Equal(names, tt.wantNames) {
				t.Errorf("names = %v, want %v", names, tt.wantNames)
			}
		})
	}
}

func TestParseMentionTokens_IDFormsCountInCandidateCap(t *testing.T) {
	var content string
	for i := 1; i <= maxMentionCandidates+10; i++ {
		content += fmt.Sprintf("<@%d> <@&%d> @u%d ", i, i, i)
	}
	got := parseMentionTokens(content)
	if n := len(got.Tokens) + len(got.UserIDs) + len(got.RoleIDs); n != maxMentionCandidates {
		t.Errorf("candidates = %d, want %d", n, maxMentionCandidates)
	}
}

func TestSendMessage_IDMentionResolves(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "hello <@2> and <@999> and @carol")
	if !slices.Equal(res.Mentions, []int64{2, 3}) {
		t.Errorf("mentions = %v, want [2 3] (unknown id ignored, id form first)", res.Mentions)
	}
	if res.Content != "hello <@2> and <@999> and @carol" {
		t.Errorf("content = %q, want the tokens stored as typed", res.Content)
	}
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d, want 1", got)
	}
}

func TestRoleMention_RaisesHoldersBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, true, 2, 3) // bob, carol

	res := sendAs(t, svc, 1, "<@&7> standup")
	if !slices.Equal(res.MentionRoles, []int64{devsRoleID}) {
		t.Fatalf("mention_roles = %v, want [%d]", res.MentionRoles, devsRoleID)
	}
	if len(res.Mentions) != 0 {
		t.Errorf("mentions = %v, want none: role holders are not listed as explicit mentions", res.Mentions)
	}
	for _, uid := range []int64{2, 3} {
		if got := mentionCount(t, database, uid); got != 1 {
			t.Errorf("holder %d mention_count = %d, want 1", uid, got)
		}
	}
	if got := mentionCount(t, database, 4); got != 0 {
		t.Errorf("non-holder mention_count = %d, want 0", got)
	}

	stored, err := database.GetRoleMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil {
		t.Fatalf("GetRoleMentionsByMessageIDs: %v", err)
	}
	if !slices.Equal(stored[res.MessageID], []int64{devsRoleID}) {
		t.Errorf("stored role mentions = %v, want [%d]", stored[res.MessageID], devsRoleID)
	}
	rows, err := database.GetMessagesForAPI(context.Background(), 10, 0, 10, 2)
	if err != nil || len(rows) != 1 {
		t.Fatalf("GetMessagesForAPI = %v, %v", rows, err)
	}
	if !slices.Equal(rows[0].MentionRoles, []int64{devsRoleID}) {
		t.Errorf("REST mention_roles = %v, want [%d]", rows[0].MentionRoles, devsRoleID)
	}
}

func TestRoleMention_UnmentionableNeedsMentionEveryone(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, false, 2)

	// alice is a plain member: the token stays text, no badge, nothing listed.
	res := sendAs(t, svc, 1, "<@&7> hello")
	if len(res.MentionRoles) != 0 {
		t.Errorf("mention_roles = %v, want none for an unmentionable role", res.MentionRoles)
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("holder mention_count = %d, want 0", got)
	}
	if res.Content != "<@&7> hello" {
		t.Errorf("content = %q, want the message kept as text", res.Content)
	}

	// mod holds MENTION_EVERYONE: the same token pings.
	res = sendAs(t, svc, 4, "<@&7> hello")
	if !slices.Equal(res.MentionRoles, []int64{devsRoleID}) {
		t.Errorf("mod mention_roles = %v, want [%d]", res.MentionRoles, devsRoleID)
	}
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("holder mention_count = %d, want 1", got)
	}
}

func TestRoleMention_UnknownRoleAndDMStayText(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, true, 2)

	if res := sendAs(t, svc, 1, "<@&404>"); len(res.MentionRoles) != 0 {
		t.Errorf("unknown role listed: %v", res.MentionRoles)
	}

	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)
	res, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "<@&7> <@2>",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(res.MentionRoles) != 0 {
		t.Errorf("DM mention_roles = %v, want none: roles have no meaning in a DM", res.MentionRoles)
	}
	if !slices.Equal(res.Mentions, []int64{2}) {
		t.Errorf("DM mentions = %v, want the id token [2]", res.Mentions)
	}
}

func TestRoleMention_BlockerSkipped(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, true, 2, 3)
	seedBlock(t, database, 2, 1) // bob blocked alice

	sendAs(t, svc, 1, "<@&7> hi")
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("blocker mention_count = %d, want 0", got)
	}
	if got := mentionCount(t, database, 3); got != 1 {
		t.Errorf("carol mention_count = %d, want 1", got)
	}
}

func TestRoleMention_EditRaisesNothing(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, true, 2, 3)

	res := sendAs(t, svc, 1, "plain")
	edited, err := svc.EditMessage(context.Background(), 1, res.MessageID, "<@&7> now")
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if !slices.Equal(edited.MentionRoles, []int64{devsRoleID}) {
		t.Errorf("edit mention_roles = %v, want [%d]: the wire keeps the role", edited.MentionRoles, devsRoleID)
	}
	for _, uid := range []int64{2, 3} {
		if got := mentionCount(t, database, uid); got != 0 {
			t.Errorf("holder %d mention_count = %d, want 0 (edits never increment)", uid, got)
		}
	}
	stored, err := database.GetRoleMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil || !slices.Equal(stored[res.MessageID], []int64{devsRoleID}) {
		t.Errorf("stored role mentions = %v, %v, want [%d]", stored[res.MessageID], err, devsRoleID)
	}

	// Editing the token away clears the stored role.
	if _, err := svc.EditMessage(context.Background(), 1, res.MessageID, "gone"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	stored, err = database.GetRoleMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil || len(stored[res.MessageID]) != 0 {
		t.Errorf("stored role mentions after edit = %v, %v, want none", stored[res.MessageID], err)
	}
}

func TestRoleMention_CountsInTheCap(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedPingRole(t, database, true, 2)

	content := "<@&7>"
	for range maxMentionsPerMessage + 5 {
		content += " @bob @carol"
	}
	content += " <@3>"
	res := sendAs(t, svc, 1, content)
	if got := len(res.MentionRoles) + len(res.Mentions); got > maxMentionsPerMessage {
		t.Errorf("user + role mentions = %d, want at most %d", got, maxMentionsPerMessage)
	}
}

func TestSanitize_KeepsIDTokens(t *testing.T) {
	for _, in := range []string{"<@7>", "hi <@&3> there", "<@7><@&3>", "a<@1>b", "<@&3> <b>x</b>"} {
		out, err := sanitizeContent(in, false)
		if err != nil {
			t.Fatalf("sanitizeContent(%q): %v", in, err)
		}
		want := in
		if in == "<@&3> <b>x</b>" {
			want = "<@&3> x"
		}
		if out != want {
			t.Errorf("sanitizeContent(%q) = %q, want %q", in, out, want)
		}
		again, err := sanitizeContent(out, false)
		if err != nil || again != out {
			t.Errorf("sanitizeContent not idempotent for %q: %q then %q (%v)", in, out, again, err)
		}
	}
}

func FuzzSanitize_KeepsIDTokens(f *testing.F) {
	for _, s := range []string{"<@7>", "<@&3>", "x<@1>&amp;<@&2>", "<<@7>>", "&lt;@7&gt;", "<@&3><script>"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		once, err := sanitizeContent(in, true)
		if err != nil {
			return
		}
		twice, err := sanitizeContent(once, true)
		if err != nil || twice != once {
			t.Fatalf("not idempotent: %q -> %q -> %q (%v)", in, once, twice, err)
		}
	})
}
