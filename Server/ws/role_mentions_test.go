package ws

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// mentionableRole creates a role that anyone may ping and gives it to users.
func (f *activityFixture) mentionableRole(t *testing.T, name string, holders ...*db.User) int64 {
	t.Helper()
	ctx := context.Background()
	role, err := f.db.CreateRole(ctx, name, nil, permissions.ReadMessages|permissions.SendMessages, 5, false, true)
	if err != nil {
		t.Fatalf("CreateRole(%s): %v", name, err)
	}
	for _, u := range holders {
		if _, err := f.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, u.ID, role.ID); err != nil {
			t.Fatalf("grant %s to %s: %v", name, u.Username, err)
		}
	}
	return role.ID
}

// TestChannelActivity_RoleMentionsYou: a holder of a pinged role gets
// mentions_you on the activity entry; a non-holder and a holder who blocked
// the author do not.
func TestChannelActivity_RoleMentionsYou(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	holder := f.user(t, "holder", permissions.MemberRoleID)
	blocker := f.user(t, "blockerholder", permissions.MemberRoleID)
	bystander := f.user(t, "bystander", permissions.MemberRoleID)
	roleID := f.mentionableRole(t, "devs", holder, blocker)
	if err := f.db.BlockUser(ctx, blocker.ID, f.author.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	holderSend := f.connect(holder, 0)
	blockerSend := f.connect(blocker, 0)
	bystanderSend := f.connect(bystander, 0)

	_, msgID := f.send(t, f.author, f.textID, "<@&"+itoa(roleID)+"> ship it")
	f.flush()

	e := wantOneEntry(t, "holder", activityFrames(holderSend))
	if e.MessageID != msgID || !e.MentionsYou || e.MentionsEveryone {
		t.Errorf("holder entry = %+v, want mentions_you on message %d", e, msgID)
	}
	if e := wantOneEntry(t, "blocker", activityFrames(blockerSend)); e.MentionsYou {
		t.Errorf("blocker entry = %+v, want no mentions_you", e)
	}
	if e := wantOneEntry(t, "bystander", activityFrames(bystanderSend)); e.MentionsYou {
		t.Errorf("bystander entry = %+v, want no mentions_you", e)
	}
}

// TestChatMessage_CarriesMentionRoles locks the additive wire field on both
// chat_message and chat_edited, empty (not null) when no role was pinged.
func TestChatMessage_CarriesMentionRoles(t *testing.T) {
	f := newActivityFixture(t)
	holder := f.user(t, "holder", permissions.MemberRoleID)
	roleID := f.mentionableRole(t, "devs", holder)

	res, _ := f.send(t, f.author, f.textID, "<@&"+itoa(roleID)+"> and <@"+itoa(holder.ID)+">")
	var sent struct {
		Payload struct {
			Mentions     []int64 `json:"mentions"`
			MentionRoles []int64 `json:"mention_roles"`
		} `json:"payload"`
	}
	var raw []byte
	for _, ev := range res.Events {
		if ce, ok := ev.(channelEvt); ok && ce.evType == MsgTypeChatMessage {
			raw = ce.payload
		}
	}
	if raw == nil || json.Unmarshal(raw, &sent) != nil {
		t.Fatalf("no decodable chat_message in %d events", len(res.Events))
	}
	if !slices.Equal(sent.Payload.MentionRoles, []int64{roleID}) || !slices.Equal(sent.Payload.Mentions, []int64{holder.ID}) {
		t.Errorf("chat_message mentions/mention_roles = %v/%v, want [%d]/[%d]",
			sent.Payload.Mentions, sent.Payload.MentionRoles, holder.ID, roleID)
	}

	plain, _ := f.send(t, f.author, f.textID, "nothing here")
	for _, ev := range plain.Events {
		if ce, ok := ev.(channelEvt); ok && ce.evType == MsgTypeChatMessage {
			if !jsonHasEmptyArray(t, ce.payload, "mention_roles") {
				t.Errorf("plain chat_message must carry mention_roles: []; got %s", ce.payload)
			}
		}
	}

	edited := buildChatEdited(1, 2, "x", time.Now().Format(time.RFC3339), nil, []int64{roleID}, false, false)
	var e struct {
		Payload struct {
			MentionRoles []int64 `json:"mention_roles"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(edited, &e); err != nil || !slices.Equal(e.Payload.MentionRoles, []int64{roleID}) {
		t.Errorf("chat_edited mention_roles = %v (%v), want [%d]", e.Payload.MentionRoles, err, roleID)
	}
	if !jsonHasEmptyArray(t, buildChatEdited(1, 2, "x", "", nil, nil, false, false), "mention_roles") {
		t.Error("chat_edited without roles must carry mention_roles: []")
	}
}

func jsonHasEmptyArray(t *testing.T, frame []byte, key string) bool {
	t.Helper()
	var env struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(frame, &env); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return string(env.Payload[key]) == "[]"
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// TestChannelActivity_RoleMentionSkipsHolderWhoCannotRead: a holder denied
// READ on the channel gets no hint, though the role was pinged.
func TestChannelActivity_RoleMentionSkipsHolderWhoCannotRead(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	denied := f.user(t, "denied", permissions.MemberRoleID)
	allowed := f.user(t, "allowed", permissions.MemberRoleID)
	roleID := f.mentionableRole(t, "devs", denied, allowed)
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, denied.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	deniedSend := f.connect(denied, 0)
	allowedSend := f.connect(allowed, 0)

	f.send(t, f.author, f.textID, "<@&"+itoa(roleID)+"> and <@"+itoa(denied.ID)+">")
	f.flush()

	if got := activityFrames(deniedSend); len(got) != 0 {
		t.Errorf("holder who cannot read received %+v, want nothing", got)
	}
	if e := wantOneEntry(t, "allowed", activityFrames(allowedSend)); !e.MentionsYou {
		t.Errorf("allowed holder entry = %+v, want mentions_you", e)
	}
	if n, _ := f.db.GetMentionCount(ctx, denied.ID, f.textID); n != 0 {
		t.Errorf("denied holder mention_count = %d, want 0", n)
	}
}

// TestChannelActivity_RoleMentionInThreadHintsFollowersOnly pins the current
// choice: a thread's hint goes to its followers, so a role holder who does not
// follow the thread gets the badge but no channel_activity entry (a role ping
// never auto-joins a thread; only a direct mention does).
func TestChannelActivity_RoleMentionInThreadHintsFollowersOnly(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	follower := f.user(t, "follower", permissions.MemberRoleID)
	holder := f.user(t, "holder", permissions.MemberRoleID)
	roleID := f.mentionableRole(t, "devs", follower, holder)
	if res := f.follow(follower.ID, true); res.Error != nil {
		t.Fatal(res.Error)
	}
	followerSend := f.connect(follower, 0)
	holderSend := f.connect(holder, 0)

	f.send(t, f.author, f.thread, "<@&"+itoa(roleID)+"> look")
	f.flush()

	if e := wantOneEntry(t, "follower", activityFrames(followerSend)); !e.MentionsYou {
		t.Errorf("follower entry = %+v, want mentions_you", e)
	}
	if got := activityFrames(holderSend); len(got) != 0 {
		t.Errorf("non-following holder received %+v, want no hint", got)
	}
	if got := f.followers(t); slices.Contains(got, holder.ID) {
		t.Errorf("followers = %v: a role ping must not auto-follow", got)
	}
	if n, err := f.db.GetMentionCount(ctx, holder.ID, f.thread); err != nil || n != 1 {
		t.Errorf("holder thread mention_count = %d (%v), want the badge", n, err)
	}
}
