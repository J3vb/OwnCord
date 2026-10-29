package ws

// WP 6.1a: a voice channel has a text chat beside its call. It follows the
// text-channel rules for who may read and post, and now carries the unread,
// mention and activity state a text channel carries.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// voiceChatClient registers a connected client for u with a user record (so
// RefreshChannelVisibility can re-evaluate it), subscribed to focus's topic
// when focus > 0.
func (f *activityFixture) voiceChatClient(u *db.User, focus int64) chan []byte {
	send := make(chan []byte, 64)
	c := NewTestClientWithUser(f.hub, u, focus, send)
	f.hub.mu.Lock()
	f.hub.clients[u.ID] = []*Client{c}
	f.hub.mu.Unlock()
	f.hub.pubsub.Subscribe(c, TopicGlobal)
	f.hub.pubsub.Subscribe(c, UserTopic(u.ID))
	if focus > 0 {
		f.hub.pubsub.Subscribe(c, ChannelTopic(focus))
	}
	return send
}

// voiceChatSend runs chat_send through the real handler without failing the
// test on a refusal, and emits the result's events on success.
func (f *activityFixture) voiceChatSend(from *db.User, chID int64, content string) Result {
	res := handleChatSendV2(context.Background(),
		ChatSendCmd{ChannelID: chID, Content: content},
		ClientInfo{UserID: from.ID, Username: from.Username, RoleName: "member"},
		ChatDeps{Limiter: f.hub.limiter, MessageSvc: f.svc.Messages, LiveStatus: f.hub.LiveStatus})
	if res.Error == nil {
		f.hub.EmitEvents(context.Background(), res.Events)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = f.hub.awaitDispatch(ctx)
	}
	return res
}

func voiceChatFrameTypes(ch chan []byte) (types []string, chatMessages []map[string]any) {
	for _, m := range drainChan(ch, 60*time.Millisecond) {
		var env struct {
			Type    string         `json:"type"`
			Seq     int64          `json:"seq"`
			Payload map[string]any `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil {
			continue
		}
		types = append(types, env.Type)
		if env.Type == "chat_message" {
			env.Payload["seq"] = env.Seq
			chatMessages = append(chatMessages, env.Payload)
		}
	}
	return types, chatMessages
}

func voiceChatErrCode(t *testing.T, res Result) string {
	t.Helper()
	var ce ClientError
	if !errors.As(res.Error, &ce) {
		t.Fatalf("result error = %v, want a ClientError", res.Error)
	}
	return ce.Code
}

// The 1B check end to end: focus on a voice channel, send, get chat_send_ok,
// and the focused reader gets a sequenced chat_message.
func TestVoiceChannelChat_SendDeliveredToFocusedReaders(t *testing.T) {
	f := newActivityFixture(t)
	startActivityHub(t, f.hub)
	sender := f.user(t, "sender", permissions.MemberRoleID)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	deps := PresenceDeps{ChannelSvc: f.svc.Channels}

	focus := handleChannelFocusV2(context.Background(),
		ChannelFocusCmd{userID: sender.ID, ChannelID: f.voiceID},
		ClientInfo{UserID: sender.ID, Username: sender.Username}, deps)
	if focus.Error != nil || focus.SetChannelID == nil || *focus.SetChannelID != f.voiceID {
		t.Fatalf("focus on the voice channel = %+v, want SetChannelID %d", focus, f.voiceID)
	}

	senderRecv := f.voiceChatClient(sender, f.voiceID)
	readerRecv := f.voiceChatClient(reader, f.voiceID)
	res := f.voiceChatSend(sender, f.voiceID, "hello from the call")
	if res.Error != nil {
		t.Fatalf("chat_send in a voice channel: %v", res.Error)
	}
	var ok struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(res.Reply, &ok); err != nil || ok.Type != "chat_send_ok" {
		t.Fatalf("reply = %s, want chat_send_ok", res.Reply)
	}
	for who, ch := range map[string]chan []byte{"sender": senderRecv, "reader": readerRecv} {
		_, msgs := voiceChatFrameTypes(ch)
		if len(msgs) != 1 {
			t.Fatalf("%s got %d chat_message frames, want 1", who, len(msgs))
		}
		if got, _ := msgs[0]["channel_id"].(float64); int64(got) != f.voiceID {
			t.Errorf("%s: chat_message channel_id = %v, want %d", who, msgs[0]["channel_id"], f.voiceID)
		}
		if seq, _ := msgs[0]["seq"].(int64); seq <= 0 {
			t.Errorf("%s: chat_message seq = %v, want a sequence number", who, msgs[0]["seq"])
		}
	}
}

// Q1 default: no "joined only" rule. A member who is not in the call reads
// (focus) and posts under the same permissions as a text channel.
func TestVoiceChannelChat_NotJoinedMayReadAndSend(t *testing.T) {
	f := newActivityFixture(t)
	startActivityHub(t, f.hub)
	outsider := f.user(t, "outsider", permissions.MemberRoleID)
	// outsider never joined the call: no voice state exists for it.
	focus := handleChannelFocusV2(context.Background(),
		ChannelFocusCmd{userID: outsider.ID, ChannelID: f.voiceID},
		ClientInfo{UserID: outsider.ID, Username: outsider.Username},
		PresenceDeps{ChannelSvc: f.svc.Channels})
	if focus.Error != nil || focus.SetChannelID == nil {
		t.Fatalf("a member outside the call was refused focus: %+v", focus)
	}
	if res := f.voiceChatSend(outsider, f.voiceID, "reading from outside"); res.Error != nil {
		t.Fatalf("a member outside the call was refused chat_send: %v", res.Error)
	}
}

// Edge 1: a READ deny override lands while a member is focused on the voice
// channel's chat. Focus and send answer FORBIDDEN, the subscription is
// dropped, a later chat_message does not reach them, and no channel_activity
// entry names the channel.
func TestVoiceChannelChat_ReadRevokedMidSession(t *testing.T) {
	f := newActivityFixture(t)
	startActivityHub(t, f.hub)
	ctx := context.Background()
	member := f.user(t, "revoked", permissions.MemberRoleID)
	recv := f.voiceChatClient(member, f.voiceID)

	if err := f.db.UpsertChannelUserOverride(ctx, f.voiceID, member.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	f.svc.Permissions.InvalidateAll()
	ch, err := f.db.GetChannel(ctx, f.voiceID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	f.hub.RefreshChannelVisibility(ch)
	drainChan(recv, 20*time.Millisecond)

	focus := handleChannelFocusV2(ctx, ChannelFocusCmd{userID: member.ID, ChannelID: f.voiceID},
		ClientInfo{UserID: member.ID, Username: member.Username}, PresenceDeps{ChannelSvc: f.svc.Channels})
	if focus.Error == nil || voiceChatErrCode(t, focus) != ErrCodeForbidden {
		t.Fatalf("focus after the revoke = %+v, want FORBIDDEN", focus)
	}
	if res := f.voiceChatSend(member, f.voiceID, "still here?"); res.Error == nil || voiceChatErrCode(t, res) != ErrCodeForbidden {
		t.Fatalf("send after the revoke = %+v, want FORBIDDEN", res)
	}

	if res := f.voiceChatSend(f.author, f.voiceID, "after the revoke"); res.Error != nil {
		t.Fatalf("author send: %v", res.Error)
	}
	f.flush()
	types, _ := voiceChatFrameTypes(recv)
	for _, ty := range types {
		if ty == "chat_message" || ty == "channel_activity" {
			t.Errorf("revoked member received %s for the voice channel, want nothing", ty)
		}
	}
}

// ready gives a voice channel the unread fields a text channel gets.
func TestBuildReady_VoiceChannelCarriesUnreadFields(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	reader := f.user(t, "ready-reader", permissions.MemberRoleID)
	msg, err := f.db.CreateMessageReturning(ctx, f.voiceID, f.author.ID, "ping", nil)
	if err != nil {
		t.Fatalf("CreateMessageReturning: %v", err)
	}
	if err := f.db.IncrementMentionCounts(ctx, f.voiceID, msg.ID, []int64{reader.ID}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	role, err := f.db.GetRoleByID(ctx, permissions.MemberRoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	raw, err := f.hub.BuildReadyWithRoleForTest(f.db, reader.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	for _, e := range env.Payload.Channels {
		if id, _ := e["id"].(float64); int64(id) != f.voiceID {
			continue
		}
		want := map[string]float64{
			"unread_count": 1, "last_message_id": float64(msg.ID),
			"mention_count": 1, "last_read_message_id": 0,
		}
		for k, v := range want {
			if got, ok := e[k].(float64); !ok || got != v {
				t.Errorf("voice channel %s = %v, want %v", k, e[k], v)
			}
		}
		return
	}
	t.Fatalf("voice channel %d missing from ready", f.voiceID)
}

// A voice channel carries the activity hint like a text channel (it used to be
// excluded). An archived one does not: the audience is CanViewChannel.
func TestChannelActivity_VoiceChannelCarriesHint(t *testing.T) {
	f := newActivityFixture(t)
	reader := f.user(t, "voice-hint-reader", permissions.MemberRoleID)
	readerSend := f.connect(reader, 0)

	f.hub.activity.note(activityNote{channelID: f.voiceID, msgID: 7, authorID: f.author.ID})
	f.flush()
	e := wantOneEntry(t, "reader", activityFrames(readerSend))
	if e.ChannelID != f.voiceID || e.MessageID != 7 {
		t.Fatalf("entry = %+v, want voice channel %d message 7", e, f.voiceID)
	}

	if _, err := f.db.ExecContext(context.Background(), `UPDATE channels SET archived = 1 WHERE id = ?`, f.voiceID); err != nil {
		t.Fatalf("archive voice channel: %v", err)
	}
	f.hub.activity.note(activityNote{channelID: f.voiceID, msgID: 8, authorID: f.author.ID})
	f.flush()
	if got := activityFrames(readerSend); len(got) != 0 {
		t.Errorf("archived voice channel hint reached the reader: %+v", got)
	}
}
