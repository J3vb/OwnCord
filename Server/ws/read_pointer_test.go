package ws

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func parseCmd(t *testing.T, msgType, payload string) (Command, error) {
	t.Helper()
	ctor, ok := getCommandConstructor(msgType)
	if !ok {
		t.Fatalf("no constructor for %s", msgType)
	}
	return ctor(7, "req", json.RawMessage(payload))
}

func TestParseMarkRead_MessageID(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    int64
		wantErr bool
	}{
		{`{"channel_id":3}`, 0, false},
		{`{"channel_id":3,"message_id":null}`, 0, false},
		{`{"channel_id":3,"message_id":5}`, 5, false},
		{`{"channel_id":3,"message_id":0}`, 0, true},
		{`{"channel_id":3,"message_id":-1}`, 0, true},
		{`{"channel_id":3,"message_id":"x"}`, 0, true},
		{`{"channel_id":3,"message_id":1.5}`, 0, true},
	} {
		cmd, err := parseCmd(t, MsgTypeMarkRead, tc.payload)
		if (err != nil) != tc.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", tc.payload, err, tc.wantErr)
			continue
		}
		if err == nil && cmd.(MarkReadCmd).MessageID != tc.want {
			t.Errorf("%s: MessageID = %d, want %d", tc.payload, cmd.(MarkReadCmd).MessageID, tc.want)
		}
	}
}

func TestParseChannelFocus_ReadFlag(t *testing.T) {
	for _, tc := range []struct {
		payload    string
		wantNoRead bool
		wantErr    bool
	}{
		{`{"channel_id":3}`, false, false},
		{`{"channel_id":3,"read":true}`, false, false},
		{`{"channel_id":3,"read":null}`, false, false},
		{`{"channel_id":3,"read":false}`, true, false},
		{`{"channel_id":3,"read":"no"}`, false, true},
	} {
		cmd, err := parseCmd(t, MsgTypeChannelFocus, tc.payload)
		if (err != nil) != tc.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", tc.payload, err, tc.wantErr)
			continue
		}
		if err == nil && cmd.(ChannelFocusCmd).NoRead != tc.wantNoRead {
			t.Errorf("%s: NoRead = %v, want %v", tc.payload, cmd.(ChannelFocusCmd).NoRead, tc.wantNoRead)
		}
	}
}

func TestParseMarkUnread(t *testing.T) {
	cmd, err := parseCmd(t, MsgTypeMarkUnread, `{"channel_id":3,"message_id":9}`)
	if err != nil {
		t.Fatalf("valid mark_unread: %v", err)
	}
	if got := cmd.(MarkUnreadCmd); got.ChannelID != 3 || got.MessageID != 9 {
		t.Errorf("cmd = %+v, want channel 3 message 9", got)
	}
	for _, payload := range []string{
		`{"channel_id":3}`, `{"channel_id":3,"message_id":null}`, `{"channel_id":3,"message_id":0}`,
		`{"channel_id":3,"message_id":-4}`, `{"channel_id":3,"message_id":"x"}`, `{"message_id":9}`,
	} {
		if _, err := parseCmd(t, MsgTypeMarkUnread, payload); err == nil {
			t.Errorf("%s: want a parse error", payload)
		}
	}
}

// readStateOf reads the stored pointer and badge for u in ch.
func (f *activityFixture) readStateOf(t *testing.T, u *db.User, ch int64) (ptr, mentions int64, found bool) {
	t.Helper()
	ptr, mentions, found, err := f.db.GetReadState(context.Background(), u.ID, ch)
	if err != nil {
		t.Fatalf("GetReadState: %v", err)
	}
	return ptr, mentions, found
}

func (f *activityFixture) presenceDeps(limiter *auth.RateLimiter) PresenceDeps {
	return PresenceDeps{Limiter: limiter, ChannelSvc: f.svc.Channels, MessageSvc: f.svc.Messages}
}

type readStateFrame struct {
	ChannelID, LastReadMessageID, UnreadCount, MentionCount int64
}

// frameCounts drains ch and returns the read_state frames it held, in order,
// and the mention_count frames' totals.
func frameCounts(ch chan []byte) (reads []readStateFrame, mentionTotals []int64) {
	for _, m := range drainChan(ch, 40*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ChannelID         int64 `json:"channel_id"`
				LastReadMessageID int64 `json:"last_read_message_id"`
				UnreadCount       int64 `json:"unread_count"`
				MentionCount      int64 `json:"mention_count"`
				Count             int64 `json:"count"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil {
			continue
		}
		switch env.Type {
		case MsgTypeReadState:
			reads = append(reads, readStateFrame{env.Payload.ChannelID, env.Payload.LastReadMessageID, env.Payload.UnreadCount, env.Payload.MentionCount})
		case MsgTypeMentionCount:
			mentionTotals = append(mentionTotals, env.Payload.Count)
		}
	}
	return reads, mentionTotals
}

func TestMarkRead_LegacyNoIDUnchanged(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	f.send(t, f.author, f.textID, "one")
	_, last := f.send(t, f.author, f.textID, "two")
	f.exec(t, `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, 0, 2)`, b.ID, f.textID)

	res := handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID},
		ClientInfo{UserID: b.ID, Username: b.Username}, f.presenceDeps(nil))
	if res.Error != nil {
		t.Fatalf("mark_read: %v", res.Error)
	}
	if ptr, mentions, _ := f.readStateOf(t, b, f.textID); ptr != last || mentions != 0 {
		t.Errorf("row = (ptr %d, mentions %d), want (%d, 0)", ptr, mentions, last)
	}
	reads, _ := frameCounts(bSend)
	if len(reads) != 1 || reads[0] != (readStateFrame{f.textID, last, 0, 0}) {
		t.Errorf("read_state frames = %+v, want exactly one {%d %d 0 0}", reads, f.textID, last)
	}
}

func (f *activityFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.db.ExecContext(context.Background(), q, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}

func TestMarkRead_ByIDSendsReadState(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	_, m1 := f.send(t, f.author, f.textID, "one")
	_, m2 := f.send(t, f.author, f.textID, "two")
	f.send(t, f.author, f.textID, "three")
	info := ClientInfo{UserID: b.ID, Username: b.Username}

	res := handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID, MessageID: m2}, info, f.presenceDeps(nil))
	if res.Error != nil {
		t.Fatalf("mark_read: %v", res.Error)
	}
	reads, _ := frameCounts(bSend)
	if len(reads) != 1 || reads[0] != (readStateFrame{f.textID, m2, 1, 0}) {
		t.Fatalf("read_state frames = %+v, want one {%d %d 1 0}", reads, f.textID, m2)
	}
	// A late older mark_read is a no-op that still answers with the true state.
	handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID, MessageID: m1}, info, f.presenceDeps(nil))
	reads, _ = frameCounts(bSend)
	if len(reads) != 1 || reads[0].LastReadMessageID != m2 {
		t.Errorf("read_state after a stale mark_read = %+v, want pointer held at %d", reads, m2)
	}
}

func TestChannelFocus_ReadFalseNoWrite(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	f.send(t, f.author, f.textID, "unread")

	res := handleChannelFocusV2(context.Background(), ChannelFocusCmd{userID: b.ID, ChannelID: f.textID, NoRead: true},
		ClientInfo{UserID: b.ID, Username: b.Username}, f.presenceDeps(nil))
	if res.Error != nil || res.SetChannelID == nil || *res.SetChannelID != f.textID {
		t.Fatalf("read:false focus must still focus: %+v", res)
	}
	if len(res.Events) != 0 {
		t.Errorf("read:false focus emitted %d events, want none (no channelReadEvt)", len(res.Events))
	}
	if _, _, found := f.readStateOf(t, b, f.textID); found {
		t.Error("read:false focus wrote a read_states row")
	}
	if reads, _ := frameCounts(bSend); len(reads) != 0 {
		t.Errorf("focus sent read_state frames: %+v", reads)
	}
	// The hint for the unread message still reaches b.
	f.hub.EmitEvents(context.Background(), res.Events)
	f.flush()
	if got := activityFrames(bSend); len(got) != 1 {
		t.Errorf("channel_activity frames after read:false focus = %+v, want one", got)
	}
}

func TestChannelFocus_ReadFalseDeferredWhenRateLimited(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	limiter := auth.NewRateLimiter()
	deps := f.presenceDeps(limiter)
	info := ClientInfo{UserID: b.ID, Username: b.Username}
	for range focusRateLimit {
		handleChannelFocusV2(context.Background(), ChannelFocusCmd{userID: b.ID, ChannelID: f.textID, NoRead: true}, info, deps)
	}
	res := handleChannelFocusV2(context.Background(), ChannelFocusCmd{userID: b.ID, ChannelID: f.textID, NoRead: true}, info, deps)
	if res.DeferChannelFocus == nil || !res.DeferChannelFocusNoRead {
		t.Errorf("deferred read:false focus = %+v, want DeferChannelFocusNoRead", res)
	}
	res = handleChannelFocusV2(context.Background(), ChannelFocusCmd{userID: b.ID, ChannelID: f.textID}, info, deps)
	if res.DeferChannelFocus == nil || res.DeferChannelFocusNoRead {
		t.Errorf("deferred default focus = %+v, want DeferChannelFocusNoRead false", res)
	}
}

func TestMarkUnread_ForbiddenNotFoundRateLimited(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	_, m1 := f.send(t, f.author, f.textID, "one")
	_, m2 := f.send(t, f.author, f.textID, "two")
	otherCh, err := f.db.CreateChannel(context.Background(), "elsewhere", "text", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	foreign, err := f.db.CreateMessage(context.Background(), otherCh, f.author.ID, "x", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	info := ClientInfo{UserID: b.ID, Username: b.Username}
	code := func(res Result) string {
		t.Helper()
		var ce ClientError
		if res.Error == nil || !errors.As(res.Error, &ce) {
			return ""
		}
		return ce.Code
	}
	deps := f.presenceDeps(nil)
	unread := func(ch, msg int64, d PresenceDeps) Result {
		return handleMarkUnreadV2(context.Background(), MarkUnreadCmd{userID: b.ID, ChannelID: ch, MessageID: msg}, info, d)
	}

	// Edge case: a message outside the channel, or deleted, is NOT_FOUND and
	// nothing changes.
	handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID}, info, deps)
	drainChan(bSend, 20*time.Millisecond)
	f.exec(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, m1)
	beforePtr, beforeMentions, _ := f.readStateOf(t, b, f.textID)
	for name, msg := range map[string]int64{"foreign": foreign, "deleted": m1, "missing": 1 << 40} {
		if got := code(unread(f.textID, msg, deps)); got != ErrCodeNotFound {
			t.Errorf("%s message: code = %q, want %q", name, got, ErrCodeNotFound)
		}
	}
	if ptr, mentions, _ := f.readStateOf(t, b, f.textID); ptr != beforePtr || mentions != beforeMentions {
		t.Errorf("a refused mark_unread changed the row to (%d,%d), was (%d,%d)", ptr, mentions, beforePtr, beforeMentions)
	}
	if reads, _ := frameCounts(bSend); len(reads) != 0 {
		t.Errorf("a refused mark_unread sent read_state frames: %+v", reads)
	}

	// Forbidden: session admission refuses an archived channel.
	f.exec(t, `UPDATE channels SET archived = 1 WHERE id = ?`, otherCh)
	if got := code(unread(otherCh, foreign, deps)); got != ErrCodeForbidden {
		t.Errorf("archived channel: code = %q, want %q", got, ErrCodeForbidden)
	}

	// Success, then rate limited on the sixth frame in the window.
	limited := f.presenceDeps(auth.NewRateLimiter())
	for i := range focusRateLimit {
		if got := code(unread(f.textID, m2, limited)); got != "" {
			t.Fatalf("in-budget mark_unread %d: code = %q", i, got)
		}
	}
	if got := code(unread(f.textID, m2, limited)); got != ErrCodeRateLimited {
		t.Errorf("sixth mark_unread: code = %q, want %q", got, ErrCodeRateLimited)
	}
}

func TestChannelActivity_PartialReadKeepsLaterHints(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	c := f.user(t, "c", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	f.connect(c, 0)
	f.send(t, f.author, f.textID, "one")
	_, m2 := f.send(t, f.author, f.textID, "two")
	_, m3 := f.send(t, f.author, f.textID, "three")
	info := ClientInfo{UserID: b.ID, Username: b.Username}

	// A partial read through m2 must not swallow the hint for m3.
	res := handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID, MessageID: m2}, info, f.presenceDeps(nil))
	f.hub.EmitEvents(context.Background(), res.Events)
	f.flush()
	if e := wantOneEntry(t, "b after partial read", activityFrames(bSend)); e.MessageID != m3 {
		t.Errorf("entry = %+v, want message %d", e, m3)
	}

	// Mark Unread lowers the mark: read through everything, then unread m3.
	f.send(t, f.author, f.textID, "four")
	_, m5 := f.send(t, f.author, f.textID, "five")
	res = handleMarkReadV2(context.Background(), MarkReadCmd{userID: b.ID, ChannelID: f.textID}, info, f.presenceDeps(nil))
	f.hub.EmitEvents(context.Background(), res.Events)
	res = handleMarkUnreadV2(context.Background(), MarkUnreadCmd{userID: b.ID, ChannelID: f.textID, MessageID: m5}, info, f.presenceDeps(nil))
	if res.Error != nil {
		t.Fatalf("mark_unread: %v", res.Error)
	}
	f.hub.EmitEvents(context.Background(), res.Events)
	f.flush()
	if e := wantOneEntry(t, "b after mark_unread", activityFrames(bSend)); e.MessageID != m5 {
		t.Errorf("entry = %+v, want message %d", e, m5)
	}
}

// The reader's last frame must equal the database whatever the interleaving of
// a mention increment (which sends mention_count under mentionEmitMu) and a
// backward move (which sends read_state under the same lock).
func TestReadState_OrderedWithMentionWorker(t *testing.T) {
	t.Parallel()
	f := newActivityFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	rSend := f.connect(reader, 0)
	info := ClientInfo{UserID: reader.ID, Username: reader.Username}
	deps := f.presenceDeps(nil)
	// The send budget (10/s per user) would stop 200 rounds, so each round
	// starts from a fresh one.
	chatDeps := ChatDeps{MessageSvc: f.svc.Messages, LiveStatus: f.hub.LiveStatus}

	// lastCount drains the queue and returns the mention total of the last
	// mention_count or read_state frame, -1 when there was none.
	lastCount := func() int64 {
		var last int64 = -1
		for _, m := range drainChan(rSend, 3*time.Millisecond) {
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Count        int64 `json:"count"`
					MentionCount int64 `json:"mention_count"`
				} `json:"payload"`
			}
			if json.Unmarshal(m, &env) != nil {
				continue
			}
			switch env.Type {
			case MsgTypeMentionCount:
				last = env.Payload.Count
			case MsgTypeReadState:
				last = env.Payload.MentionCount
			}
		}
		return last
	}

	known := int64(0) // the count the reader believes, from its last frame
	for round := range 200 {
		f.hub.limiter.Reset(context.Background(), auth.Key("chat", f.author.ID))
		handleMarkReadV2(context.Background(), MarkReadCmd{userID: reader.ID, ChannelID: f.textID}, info, deps)
		_, latest := f.send(t, f.author, f.textID, "filler")
		if last := lastCount(); last >= 0 {
			known = last
		}

		done := make(chan struct{})
		go func() {
			defer close(done)
			handleChatSendV2(context.Background(), ChatSendCmd{ChannelID: f.textID, Content: "@reader ping"},
				ClientInfo{UserID: f.author.ID, Username: f.author.Username, RoleName: "owner"}, chatDeps)
		}()
		unreadRes := handleMarkUnreadV2(context.Background(), MarkUnreadCmd{userID: reader.ID, ChannelID: f.textID, MessageID: latest}, info, deps)
		<-done
		if unreadRes.Error != nil {
			t.Fatalf("round %d: mark_unread: %v", round, unreadRes.Error)
		}

		// Frames arrive on one queue in the order the locked sections ran, so
		// the last one carries the latest committed count.
		if last := lastCount(); last >= 0 {
			known = last
		}
		if _, stored, _ := f.readStateOf(t, reader, f.textID); stored != known {
			t.Fatalf("round %d: the reader's last frame says %d mentions, the database has %d", round, known, stored)
		}
	}
}

func TestReady_CapabilityReadPointer(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	raw, err := f.hub.readyBytes(f.db, b.ID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Capabilities map[string]any `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if got, ok := env.Payload.Capabilities["read_pointer"].(bool); !ok || !got {
		t.Errorf("capabilities.read_pointer = %v, want true", env.Payload.Capabilities["read_pointer"])
	}
}

func TestMarkUnread_DMParticipantOnly(t *testing.T) {
	f := newActivityFixture(t)
	a := f.user(t, "dm-a", permissions.MemberRoleID)
	b := f.user(t, "dm-b", permissions.MemberRoleID)
	outsider := f.user(t, "dm-outsider", permissions.MemberRoleID)
	dmChannel, _, err := f.db.GetOrCreateDMChannel(context.Background(), a.ID, b.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	dmCh := dmChannel.ID
	m1, err := f.db.CreateMessage(context.Background(), dmCh, b.ID, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	m2, err := f.db.CreateMessage(context.Background(), dmCh, b.ID, "again", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	aSend := f.connect(a, 0)
	deps := f.presenceDeps(nil)
	run := func(u *db.User) Result {
		return handleMarkUnreadV2(context.Background(), MarkUnreadCmd{userID: u.ID, ChannelID: dmCh, MessageID: m2},
			ClientInfo{UserID: u.ID, Username: u.Username}, deps)
	}

	if res := run(a); res.Error != nil {
		t.Fatalf("participant mark_unread: %v", res.Error)
	}
	reads, _ := frameCounts(aSend)
	if len(reads) != 1 || reads[0] != (readStateFrame{dmCh, m1, 1, 0}) {
		t.Errorf("participant frames = %+v, want one {%d %d 1 0}", reads, dmCh, m1)
	}

	res := run(outsider)
	var ce ClientError
	if !errors.As(res.Error, &ce) || ce.Code != ErrCodeForbidden {
		t.Errorf("non-participant: error = %v, want FORBIDDEN", res.Error)
	}
	if _, _, found := f.readStateOf(t, outsider, dmCh); found {
		t.Error("a refused non-participant left a read_states row")
	}
}

func TestReady_CapabilityDMPrivacyAndNoSettingsInPayload(t *testing.T) {
	f := newActivityFixture(t)
	a := f.user(t, "priv-a", permissions.MemberRoleID)
	b := f.user(t, "priv-b", permissions.MemberRoleID)
	if err := f.db.SetUserPrivacy(context.Background(), a.ID, db.UserPrivacy{}); err != nil {
		t.Fatalf("SetUserPrivacy: %v", err)
	}
	raw, err := f.hub.readyBytes(f.db, b.ID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Capabilities map[string]any `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if got, ok := env.Payload.Capabilities["dm_privacy"].(bool); !ok || !got {
		t.Errorf("capabilities.dm_privacy = %v, want true", env.Payload.Capabilities["dm_privacy"])
	}
	if got, ok := env.Payload.Capabilities["polls"].(bool); !ok || !got {
		t.Errorf("capabilities.polls = %v, want true", env.Payload.Capabilities["polls"])
	}
	for _, key := range []string{"allow_member_dms", "message_requests"} {
		if strings.Contains(string(raw), key) {
			t.Errorf("ready payload carries %q: another member's setting must not reach a viewer", key)
		}
	}
}
