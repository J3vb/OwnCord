package service

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// newMentionFixture builds a channel 10 with three members (alice=1 author,
// bob=2 online, carol=3 offline) plus a moderator (mod=4) holding
// MENTION_EVERYONE. Every role can read channel 10.
func newMentionFixture(t *testing.T) (*MessageService, *ChannelService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedRole(t, database, &db.Role{
		ID:   permissions.ModeratorRoleID,
		Name: "moderator",
		Permissions: permissions.SendMessages | permissions.ReadMessages |
			permissions.MentionEveryone,
		Position: 60,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice", Status: "online"})
	seedUser(t, database, &db.User{ID: 2, Username: "Bob", Status: "online"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol", Status: "offline"})
	seedUser(t, database, &db.User{ID: 4, Username: "mod", Status: "online"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedUserRole(t, database, 3, permissions.MemberRoleID)
	seedUserRole(t, database, 4, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)
	return NewMessageService(database, permSvc, nil), NewChannelService(database, permSvc), database
}

func sendAs(t *testing.T, svc *MessageService, userID int64, content string) *SendMessageResult {
	t.Helper()
	res, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10,
		UserID:    userID,
		Username:  "user",
		RoleName:  "member",
		Content:   content,
	})
	if err != nil {
		t.Fatalf("SendMessage(%q): %v", content, err)
	}
	return res
}

func mentionCount(t *testing.T, database *db.DB, userID int64) int {
	t.Helper()
	n, err := database.GetMentionCount(context.Background(), userID, 10)
	if err != nil {
		t.Fatalf("GetMentionCount(%d): %v", userID, err)
	}
	return n
}

// ─── parsing ─────────────────────────────────────────────────────────────────

func TestParseMentionTokens(t *testing.T) {
	tests := []struct {
		name         string
		content      string
		wantTokens   []string
		wantEveryone bool
		wantHere     bool
	}{
		{name: "plain token", content: "hi @bob", wantTokens: []string{"bob"}},
		{name: "lowercased", content: "hi @BoB", wantTokens: []string{"bob"}},
		{name: "deduplicated", content: "@bob @bob @carol", wantTokens: []string{"bob", "carol"}},
		{name: "no token", content: "no mentions here", wantTokens: nil},
		{name: "email is not a mention", content: "write to bob@example.com", wantTokens: nil},
		{name: "double at is not a mention", content: "@@bob", wantTokens: nil},
		{name: "punctuation delimits", content: "(@bob), @carol!", wantTokens: []string{"bob", "carol"}},
		{name: "everyone reserved", content: "@everyone hi", wantEveryone: true},
		{name: "here reserved", content: "@here hi", wantHere: true},
		{name: "case-insensitive reserved", content: "@EVERYONE", wantEveryone: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokens, everyone, here := parseMentionTokens(tt.content)
			var got []string
			for _, tok := range tokens {
				got = append(got, tok.spellings[0])
			}
			if strings.Join(got, ",") != strings.Join(tt.wantTokens, ",") {
				t.Errorf("tokens = %v, want %v", got, tt.wantTokens)
			}
			if everyone != tt.wantEveryone {
				t.Errorf("everyone = %v, want %v", everyone, tt.wantEveryone)
			}
			if here != tt.wantHere {
				t.Errorf("here = %v, want %v", here, tt.wantHere)
			}
		})
	}
}

// TestParseMentionTokens_TrailingPunctuationSpelling locks the fallback that
// makes "@bob." resolve to bob when no user is literally named "bob.".
func TestParseMentionTokens_TrailingPunctuationSpelling(t *testing.T) {
	tokens, _, _ := parseMentionTokens("thanks @bob.")
	if len(tokens) != 1 {
		t.Fatalf("tokens = %d, want 1", len(tokens))
	}
	if got := tokens[0].spellings; len(got) != 2 || got[0] != "bob." || got[1] != "bob" {
		t.Errorf("spellings = %v, want [bob. bob]", got)
	}
}

func TestParseMentionTokens_CandidateCap(t *testing.T) {
	var sb strings.Builder
	for i := range maxMentionCandidates + 20 {
		fmt.Fprintf(&sb, "@user%d ", i)
	}
	tokens, _, _ := parseMentionTokens(sb.String())
	if len(tokens) != maxMentionCandidates {
		t.Errorf("tokens = %d, want %d", len(tokens), maxMentionCandidates)
	}
}

// ─── resolution on the send path ─────────────────────────────────────────────

func TestSendMessage_ResolvesKnownUsername(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "hey @Bob, look at this")
	if len(res.Mentions) != 1 || res.Mentions[0] != 2 {
		t.Fatalf("mentions = %v, want [2]", res.Mentions)
	}
	if res.MentionsEveryone {
		t.Error("mentions_everyone should be false")
	}

	stored, err := database.GetMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(stored[res.MessageID]) != 1 || stored[res.MessageID][0] != 2 {
		t.Errorf("stored mentions = %v, want [2]", stored[res.MessageID])
	}
}

func TestSendMessage_CaseInsensitiveUsername(t *testing.T) {
	svc, _, _ := newMentionFixture(t)

	res := sendAs(t, svc, 1, "hi @bOB")
	if len(res.Mentions) != 1 || res.Mentions[0] != 2 {
		t.Fatalf("mentions = %v, want [2]", res.Mentions)
	}
}

func TestSendMessage_UnknownWordStaysText(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "@nobody @bob@example.com hello")
	if len(res.Mentions) != 0 {
		t.Fatalf("mentions = %v, want none", res.Mentions)
	}
	if res.Content != "@nobody @bob@example.com hello" {
		t.Errorf("content was rewritten: %q", res.Content)
	}
	stored, err := database.GetMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(stored) != 0 {
		t.Errorf("stored mentions = %v, want none", stored)
	}
}

func TestSendMessage_MentionCapped(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	// 25 distinct mentionable users, all readers of channel 10.
	var sb strings.Builder
	for i := range 25 {
		id := int64(100 + i)
		name := fmt.Sprintf("capuser%d", i)
		seedUser(t, database, &db.User{ID: id, Username: name, Status: "online"})
		seedUserRole(t, database, id, permissions.MemberRoleID)
		sb.WriteString("@" + name + " ")
	}

	res := sendAs(t, svc, 1, sb.String())
	if len(res.Mentions) != maxMentionsPerMessage {
		t.Fatalf("mentions = %d, want %d", len(res.Mentions), maxMentionsPerMessage)
	}
	stored, err := database.GetMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(stored[res.MessageID]) != maxMentionsPerMessage {
		t.Errorf("stored = %d, want %d", len(stored[res.MessageID]), maxMentionsPerMessage)
	}
}

// ─── @everyone / @here permission gate ───────────────────────────────────────

func TestSendMessage_EveryoneRequiresPermission(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "@everyone stand up") // alice is a plain member
	if res.MentionsEveryone {
		t.Fatal("@everyone without MENTION_EVERYONE must not gain mention semantics")
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("bob mention_count = %d, want 0", got)
	}

	res = sendAs(t, svc, 4, "@everyone stand up") // mod holds the bit
	if !res.MentionsEveryone {
		t.Fatal("@everyone with MENTION_EVERYONE must be honored")
	}
}

func TestSendMessage_EveryoneCountsEveryReaderButAuthor(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	sendAs(t, svc, 4, "@everyone meeting now")
	for _, uid := range []int64{1, 2, 3} {
		if got := mentionCount(t, database, uid); got != 1 {
			t.Errorf("user %d mention_count = %d, want 1", uid, got)
		}
	}
	if got := mentionCount(t, database, 4); got != 0 {
		t.Errorf("author mention_count = %d, want 0", got)
	}
}

func TestSendMessage_HereSkipsOfflineUsers(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	sendAs(t, svc, 4, "@here quick question")
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("online bob mention_count = %d, want 1", got)
	}
	if got := mentionCount(t, database, 3); got != 0 {
		t.Errorf("offline carol mention_count = %d, want 0", got)
	}
}

// TestSendMessage_EveryoneSkipsUsersWithoutRead locks that the @everyone
// fan-out honors per-channel denies, not just the base role mask.
func TestSendMessage_EveryoneSkipsUsersWithoutRead(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages)

	sendAs(t, svc, 4, "@everyone private notice")
	for _, uid := range []int64{1, 2, 3} {
		if got := mentionCount(t, database, uid); got != 0 {
			t.Errorf("denied user %d mention_count = %d, want 0", uid, got)
		}
	}
}

// TestSendMessage_EveryoneHonorsUserOverrides locks the per-user layer in the
// @everyone fan-out: it is the last layer of the resolution order, so it must
// both DROP a reader the role admitted and ADD one the role excluded.
func TestSendMessage_EveryoneHonorsUserOverrides(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	// The role cannot read the channel at all...
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages)
	// ...but bob is individually granted READ back.
	if err := database.UpsertChannelUserOverride(context.Background(), 10, 2, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride bob: %v", err)
	}

	sendAs(t, svc, 4, "@everyone notice")
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob (user allow) mention_count = %d, want 1", got)
	}
	if got := mentionCount(t, database, 3); got != 0 {
		t.Errorf("carol (no override) mention_count = %d, want 0", got)
	}
}

func TestSendMessage_EveryoneSkipsUserDenied(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	// carol alone is denied READ on a channel her role can read.
	if err := database.UpsertChannelUserOverride(context.Background(), 10, 3, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride carol: %v", err)
	}

	sendAs(t, svc, 4, "@everyone notice")
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d, want 1", got)
	}
	if got := mentionCount(t, database, 3); got != 0 {
		t.Errorf("carol (user deny) mention_count = %d, want 0", got)
	}
}

// A direct @mention of a user the channel's per-user deny excludes must not
// raise their badge either — mentionReaders is the single gate behind both.
func TestSendMessage_DirectMentionSkipsUserDenied(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	if err := database.UpsertChannelUserOverride(context.Background(), 10, 2, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride bob: %v", err)
	}

	sendAs(t, svc, 1, "@bob ping")
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("user-denied bob mention_count = %d, want 0", got)
	}
}

// ─── mention counts ──────────────────────────────────────────────────────────

func TestSendMessage_DirectMentionIncrementsCount(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	sendAs(t, svc, 1, "@bob ping")
	sendAs(t, svc, 1, "@bob again")
	if got := mentionCount(t, database, 2); got != 2 {
		t.Errorf("bob mention_count = %d, want 2", got)
	}
	if got := mentionCount(t, database, 3); got != 0 {
		t.Errorf("uninvolved carol mention_count = %d, want 0", got)
	}
}

func TestSendMessage_SelfMentionDoesNotCount(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	sendAs(t, svc, 2, "note to self @bob")
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("self-mention mention_count = %d, want 0", got)
	}
}

func TestSendMessage_BlockedAuthorDoesNotRaiseBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedBlock(t, database, 2, 1) // bob blocked alice

	sendAs(t, svc, 1, "@bob @carol hello")
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("blocker mention_count = %d, want 0", got)
	}
	if got := mentionCount(t, database, 3); got != 1 {
		t.Errorf("carol mention_count = %d, want 1", got)
	}
}

func TestChannelFocus_ClearsMentionCount(t *testing.T) {
	msgSvc, chanSvc, database := newMentionFixture(t)

	sendAs(t, msgSvc, 1, "@bob look")
	if got := mentionCount(t, database, 2); got != 1 {
		t.Fatalf("setup: bob mention_count = %d, want 1", got)
	}

	if _, err := chanSvc.HandleChannelFocus(context.Background(), 2, 10); err != nil {
		t.Fatalf("HandleChannelFocus: %v", err)
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("after focus mention_count = %d, want 0", got)
	}
}

// ─── edits ───────────────────────────────────────────────────────────────────

func TestEditMessage_ReplacesMentionsWithoutRecounting(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "@bob first")
	if got := mentionCount(t, database, 2); got != 1 {
		t.Fatalf("setup: bob mention_count = %d, want 1", got)
	}

	edited, err := svc.EditMessage(context.Background(), 1, res.MessageID, "@carol instead")
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if len(edited.Mentions) != 1 || edited.Mentions[0] != 3 {
		t.Fatalf("edited mentions = %v, want [3]", edited.Mentions)
	}

	stored, err := database.GetMentionsByMessageIDs(context.Background(), []int64{res.MessageID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(stored[res.MessageID]) != 1 || stored[res.MessageID][0] != 3 {
		t.Errorf("stored mentions = %v, want [3]", stored[res.MessageID])
	}

	// Edits never advance badges — bob keeps his one, carol gains none.
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d, want 1", got)
	}
	if got := mentionCount(t, database, 3); got != 0 {
		t.Errorf("carol mention_count = %d, want 0 (edits never increment)", got)
	}
}

func TestEditMessage_EveryoneGateApplies(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	res := sendAs(t, svc, 1, "plain text")
	if _, err := svc.EditMessage(context.Background(), 1, res.MessageID, "@everyone actually"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	msg, err := database.GetMessage(context.Background(), res.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.MentionsEveryone {
		t.Error("edit by a member must not set mentions_everyone")
	}
}

// ─── read-state fan-out ──────────────────────────────────────────────────────

func TestGetChannelUnreadCounts_CarriesMentionCount(t *testing.T) {
	svc, _, database := newMentionFixture(t)

	sendAs(t, svc, 1, "@bob check the ready payload")
	counts, err := database.GetChannelUnreadCounts(context.Background(), 2)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	got, ok := counts[10]
	if !ok {
		t.Fatal("channel 10 missing from unread counts")
	}
	if got.MentionCount != 1 {
		t.Errorf("mention_count = %d, want 1", got.MentionCount)
	}
	if got.UnreadCount != 1 {
		t.Errorf("unread_count = %d, want 1", got.UnreadCount)
	}
}

// TestSendMessage_DMMentionsResolve locks that DMs resolve usernames but never
// gain @everyone semantics — there is no permission surface behind a DM.
func TestSendMessage_DMMentionsResolve(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)

	res, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "@bob @everyone hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(res.Mentions) != 1 || res.Mentions[0] != 2 {
		t.Errorf("mentions = %v, want [2]", res.Mentions)
	}
	if res.MentionsEveryone {
		t.Error("DM must not honor @everyone")
	}
}
