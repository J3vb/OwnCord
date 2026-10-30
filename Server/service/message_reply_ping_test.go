package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// replyPingFixture is the mention fixture plus bob's message to reply to.
// alice=1 replies to bob=2's parent message in channel 10.
func replyPingFixture(t *testing.T) (svc *MessageService, database *db.DB, parent int64) {
	t.Helper()
	svc, _, database = newMentionFixture(t)
	parent, err := database.CreateMessage(context.Background(), 10, 2, "the parent", nil)
	if err != nil {
		t.Fatalf("CreateMessage(parent): %v", err)
	}
	return svc, database, parent
}

// replyAs sends a reply to parent from userID, over the keyed or unkeyed path.
func replyAs(t *testing.T, svc *MessageService, keyed bool, userID, parent int64, ping bool, content string) *SendMessageResult {
	t.Helper()
	p := SendMessageParams{
		ChannelID: 10, UserID: userID, Username: "user", RoleName: "member",
		Content: content, ReplyTo: &parent, ReplyPing: ping,
	}
	if keyed {
		p.ClientMessageID = deliveryTestID(time.Now())
	}
	res, err := svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatalf("SendMessage(reply %q): %v", content, err)
	}
	return res
}

func eachSendPath(t *testing.T, fn func(t *testing.T, keyed bool)) {
	t.Helper()
	for _, keyed := range []bool{false, true} {
		t.Run(fmt.Sprintf("keyed=%v", keyed), func(t *testing.T) { fn(t, keyed) })
	}
}

func storedMentions(t *testing.T, database *db.DB, msgID int64) []int64 {
	t.Helper()
	got, err := database.GetMentionsByMessageIDs(context.Background(), []int64{msgID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	ids := slices.Clone(got[msgID])
	slices.Sort(ids)
	return ids
}

func TestSendMessage_ReplyPingMentionsParentAuthor(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)

		res := replyAs(t, svc, keyed, 1, parent, true, "agreed")
		if !slices.Equal(res.Mentions, []int64{2}) {
			t.Errorf("Mentions = %v, want [2]", res.Mentions)
		}
		if got := storedMentions(t, database, res.MessageID); !slices.Equal(got, []int64{2}) {
			t.Errorf("stored mentions = %v, want [2]", got)
		}
		if got := mentionCount(t, database, 2); got != 1 {
			t.Errorf("bob mention_count = %d, want 1", got)
		}
	})
}

func TestSendMessage_ReplyPingOffOrAbsentNoMention(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)

		// ReplyPing false is both "off" and "field absent" at this layer.
		res := replyAs(t, svc, keyed, 1, parent, false, "agreed")
		if len(res.Mentions) != 0 {
			t.Errorf("Mentions = %v, want none", res.Mentions)
		}
		if got := mentionCount(t, database, 2); got != 0 {
			t.Errorf("bob mention_count = %d, want 0", got)
		}

		// Ping off, but the content itself says @bob: still a mention.
		res = replyAs(t, svc, keyed, 1, parent, false, "agreed @bob")
		if !slices.Equal(res.Mentions, []int64{2}) {
			t.Errorf("content mention Mentions = %v, want [2]", res.Mentions)
		}
		if got := mentionCount(t, database, 2); got != 1 {
			t.Errorf("bob mention_count = %d, want 1", got)
		}
	})
}

func TestSendMessage_ReplyPingWithoutReplyToIgnored(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	res, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "hello", ReplyPing: true,
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(res.Mentions) != 0 {
		t.Errorf("Mentions = %v, want none", res.Mentions)
	}
	if got := storedMentions(t, database, res.MessageID); len(got) != 0 {
		t.Errorf("stored mentions = %v, want none", got)
	}
}

func TestSendMessage_ReplyPingSelfReplyNoPing(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, _ := replyPingFixture(t)
		own, err := database.CreateMessage(context.Background(), 10, 1, "my own", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}

		res := replyAs(t, svc, keyed, 1, own, true, "following up")
		if len(res.Mentions) != 0 {
			t.Errorf("Mentions = %v, want none", res.Mentions)
		}
		if got := storedMentions(t, database, res.MessageID); len(got) != 0 {
			t.Errorf("stored mentions = %v, want none", got)
		}
		if got := mentionCount(t, database, 1); got != 0 {
			t.Errorf("alice mention_count = %d, want 0", got)
		}
	})
}

func TestSendMessage_ReplyPingBlockedByParentNoBadge(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		seedBlock(t, database, 2, 1) // bob blocked alice

		res := replyAs(t, svc, keyed, 1, parent, true, "agreed")
		// Like an @name today, the id is stored but nothing is raised.
		if !slices.Equal(res.Mentions, []int64{2}) {
			t.Errorf("Mentions = %v, want [2]", res.Mentions)
		}
		if got := mentionCount(t, database, 2); got != 0 {
			t.Errorf("blocker mention_count = %d, want 0", got)
		}
	})
}

func TestSendMessage_ReplyPingParentCannotReadNoBadge(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		if err := database.UpsertChannelUserOverride(context.Background(), 10, 2, 0, permissions.ReadMessages); err != nil {
			t.Fatalf("UpsertChannelUserOverride: %v", err)
		}

		replyAs(t, svc, keyed, 1, parent, true, "agreed")
		if got := mentionCount(t, database, 2); got != 0 {
			t.Errorf("bob (cannot read) mention_count = %d, want 0", got)
		}
	})
}

func TestSendMessage_ReplyPingTwentyContentMentionsKeepTarget(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		content := ""
		for i := range maxMentionsPerMessage + 1 {
			id := int64(100 + i)
			seedUser(t, database, &db.User{ID: id, Username: fmt.Sprintf("extra%d", i), Status: "online"})
			seedUserRole(t, database, id, permissions.MemberRoleID)
			content += fmt.Sprintf("@extra%d ", i)
		}

		res := replyAs(t, svc, keyed, 1, parent, true, content)
		if len(res.Mentions) != maxMentionsPerMessage+1 {
			t.Fatalf("Mentions = %d ids, want %d", len(res.Mentions), maxMentionsPerMessage+1)
		}
		if !slices.Contains(res.Mentions, 2) {
			t.Errorf("Mentions %v lost the reply target 2", res.Mentions)
		}
		stored := storedMentions(t, database, res.MessageID)
		if len(stored) != maxMentionsPerMessage+1 || !slices.Contains(stored, 2) {
			t.Errorf("stored mentions = %v, want %d ids including 2", stored, maxMentionsPerMessage+1)
		}
	})
}

// seedExtras adds n members named extra0..extra<n-1> (ids 100..) and returns
// content mentioning each of them once.
func seedExtras(t *testing.T, database *db.DB, n int) string {
	t.Helper()
	content := ""
	for i := range n {
		id := int64(100 + i)
		seedUser(t, database, &db.User{ID: id, Username: fmt.Sprintf("extra%d", i), Status: "online"})
		seedUserRole(t, database, id, permissions.MemberRoleID)
		content += fmt.Sprintf(" @extra%d", i)
	}
	return content
}

// A reply target the content also names takes no content slot: @bob plus
// twenty others keeps all twenty, on send and again on edit.
func TestReplyPing_TargetNamedInContentTakesNoSlot(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		content := "@bob" + seedExtras(t, database, maxMentionsPerMessage)
		last := int64(100 + maxMentionsPerMessage - 1)

		res := replyAs(t, svc, keyed, 1, parent, true, content)
		if len(res.Mentions) != maxMentionsPerMessage+1 || !slices.Contains(res.Mentions, 2) || !slices.Contains(res.Mentions, last) {
			t.Errorf("send Mentions = %v, want %d ids including 2 and %d", res.Mentions, maxMentionsPerMessage+1, last)
		}
		if stored := storedMentions(t, database, res.MessageID); len(stored) != maxMentionsPerMessage+1 || !slices.Contains(stored, last) {
			t.Errorf("send stored = %v, want %d ids including %d", stored, maxMentionsPerMessage+1, last)
		}

		edited, err := svc.EditMessage(context.Background(), 1, res.MessageID, content+" (edited)")
		if err != nil {
			t.Fatalf("EditMessage: %v", err)
		}
		if len(edited.Mentions) != maxMentionsPerMessage+1 || !slices.Contains(edited.Mentions, last) {
			t.Errorf("edit Mentions = %v, want %d ids including %d", edited.Mentions, maxMentionsPerMessage+1, last)
		}
		if stored := storedMentions(t, database, res.MessageID); len(stored) != maxMentionsPerMessage+1 || !slices.Contains(stored, last) {
			t.Errorf("edit stored = %v, want %d ids including %d", stored, maxMentionsPerMessage+1, last)
		}
	})
}

// Without a reply ping the content cap is unchanged: the spare id
// resolveMentions keeps never reaches the stored set.
func TestSendMessage_NoReplyPingStillCapsAtTwenty(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	content := seedExtras(t, database, maxMentionsPerMessage+1)
	res, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: content,
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(res.Mentions) != maxMentionsPerMessage {
		t.Errorf("Mentions = %d ids, want %d", len(res.Mentions), maxMentionsPerMessage)
	}
	edited, err := svc.EditMessage(context.Background(), 1, res.MessageID, content+" (edited)")
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if len(edited.Mentions) != maxMentionsPerMessage {
		t.Errorf("edit Mentions = %d ids, want %d", len(edited.Mentions), maxMentionsPerMessage)
	}
	if stored := storedMentions(t, database, res.MessageID); len(stored) != maxMentionsPerMessage {
		t.Errorf("stored = %d ids, want %d", len(stored), maxMentionsPerMessage)
	}
}

func TestEditMessage_KeepsReplyPing(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		res := replyAs(t, svc, keyed, 1, parent, true, "agreed")

		edited, err := svc.EditMessage(context.Background(), 1, res.MessageID, "agreed, with @carol")
		if err != nil {
			t.Fatalf("EditMessage: %v", err)
		}
		if !slices.Contains(edited.Mentions, 2) || !slices.Contains(edited.Mentions, 3) {
			t.Errorf("edited Mentions = %v, want 2 and 3", edited.Mentions)
		}
		if got := storedMentions(t, database, res.MessageID); !slices.Equal(got, []int64{2, 3}) {
			t.Errorf("stored mentions = %v, want [2 3]", got)
		}
		if got := mentionCount(t, database, 2); got != 1 {
			t.Errorf("bob mention_count = %d, want 1 (an edit never raises a badge)", got)
		}
		if got := mentionCount(t, database, 3); got != 0 {
			t.Errorf("carol mention_count = %d, want 0", got)
		}
	})
}

func TestDeleteMessage_ReversesReplyPingBadgeAfterEdit(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		res := replyAs(t, svc, keyed, 1, parent, true, "agreed")
		if got := mentionCount(t, database, 2); got != 1 {
			t.Fatalf("setup: bob mention_count = %d, want 1", got)
		}
		if _, err := svc.EditMessage(context.Background(), 1, res.MessageID, "agreed, edited"); err != nil {
			t.Fatalf("EditMessage: %v", err)
		}

		if _, err := svc.DeleteMessage(context.Background(), 1, res.MessageID); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		if got := mentionCount(t, database, 2); got != 0 {
			t.Errorf("bob mention_count = %d after delete, want 0", got)
		}
	})
}

func TestSendMessage_ReplyPingFingerprint(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	parent, err := database.CreateMessage(context.Background(), 10, 2, "the parent", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	key := deliveryTestID(time.Now())
	base := SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "agreed",
		ReplyTo: &parent, ClientMessageID: key,
	}

	if _, err := svc.SendMessage(context.Background(), base); err != nil {
		t.Fatalf("first send: %v", err)
	}
	flipped := base
	flipped.ReplyPing = true
	if _, err := svc.SendMessage(context.Background(), flipped); !errors.Is(err, ErrConflict) {
		t.Errorf("same key with the ping flipped = %v, want ErrConflict", err)
	}
	// The identical request is still a plain retry.
	retry, err := svc.SendMessage(context.Background(), base)
	if err != nil || !retry.Duplicate {
		t.Errorf("identical retry = (%+v, %v), want a duplicate acknowledgment", retry, err)
	}
}

// A false ping must hash exactly as the fingerprint did before the field
// existed, so receipts written before the deploy still match their retries.
func TestSendMessage_ReplyPingFalseHashIsUnchanged(t *testing.T) {
	parent := int64(1040)
	p := SendMessageParams{
		ChannelID: 10, UserID: 1, Content: "agreed", ReplyTo: &parent,
		AttachmentIDs: []string{"a", "b"}, ClientMessageID: deliveryTestID(time.Now()),
	}
	legacy, err := json.Marshal(struct {
		ChannelID   int64
		Content     string
		ReplyTo     *int64
		Attachments []string
	}{p.ChannelID, p.Content, p.ReplyTo, p.AttachmentIDs})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := sha256.Sum256(legacy)

	got, err := messageDeliveryParams(p, 0)
	if err != nil {
		t.Fatalf("messageDeliveryParams: %v", err)
	}
	if !bytes.Equal(got.PayloadHash, want[:]) {
		t.Error("a false reply_ping changed the fingerprint")
	}
	p.ReplyPing = true
	pinged, err := messageDeliveryParams(p, 0)
	if err != nil {
		t.Fatalf("messageDeliveryParams: %v", err)
	}
	if bytes.Equal(pinged.PayloadHash, want[:]) {
		t.Error("reply_ping=true must change the fingerprint")
	}
}

// An imported parent belongs to the hidden import account: replying with the
// ping on writes no mention row and raises no badge for it.
func TestSendMessage_ReplyPingToImportedParentMentionsNobody(t *testing.T) {
	eachSendPath(t, func(t *testing.T, keyed bool) {
		svc, database, parent := replyPingFixture(t)
		if _, err := database.ExecContext(context.Background(),
			`INSERT INTO message_import_authors (message_id, discord_user_id, name, color) VALUES (?, '42', 'Ann', NULL)`, parent); err != nil {
			t.Fatal(err)
		}

		res := replyAs(t, svc, keyed, 1, parent, true, "agreed")
		if len(res.Mentions) != 0 {
			t.Errorf("Mentions = %v, want none", res.Mentions)
		}
		if got := storedMentions(t, database, res.MessageID); len(got) != 0 {
			t.Errorf("stored mentions = %v, want none", got)
		}
		if got := mentionCount(t, database, 2); got != 0 {
			t.Errorf("parent owner mention_count = %d, want 0", got)
		}
	})
}
