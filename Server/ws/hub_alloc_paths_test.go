package ws

import (
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// The limiter key is the bucket name every channel frame is charged against, so its text
// must stay what it was when it was built from ChannelTopic by concatenation.
func TestTopicLimiterKeyShape(t *testing.T) {
	channels := []int64{0, 1, 42, math.MaxInt64, math.MinInt64, -7}
	senders := []int64{0, 1, 99, 100, math.MaxInt64, math.MinInt64}
	longest := 0
	for _, ch := range channels {
		for _, snd := range senders {
			want := "topic:" + string(ChannelTopic(ch))
			if snd != 0 {
				want += ":" + strconv.FormatInt(snd, 10)
			}
			got := topicLimiterKey(broadcastMsg{channelID: ch, senderID: snd})
			if got != want {
				t.Errorf("topicLimiterKey(channel %d, sender %d) = %q, want %q", ch, snd, got, want)
			}
			longest = max(longest, len(got))
		}
	}
	if got := topicLimiterKey(broadcastMsg{channelID: 42}); got != "topic:channel:42" {
		t.Errorf("a server-originated frame's key = %q, want the channel's own key", got)
	}
	if got := topicLimiterKey(broadcastMsg{channelID: 42, senderID: 7}); got != "topic:channel:42:7" {
		t.Errorf("a member's key = %q, want topic:channel:42:7", got)
	}
	// The key is built in a 64-byte stack buffer; the longest key there can be must fit it.
	if longest != 55 {
		t.Errorf("longest key is %d bytes, want 55 (two 20-character ids)", longest)
	}
}

// fewestAllocs is the lowest of a few AllocsPerRun readings. The counter is process-wide, so
// another goroutine's work can only push a reading up, never down: the lowest one is f's own.
func fewestAllocs(f func()) float64 {
	fewest := testing.AllocsPerRun(1000, f)
	for range 4 {
		fewest = min(fewest, testing.AllocsPerRun(1000, f))
	}
	return fewest
}

func TestTopicLimiterKeyAllocatesOnce(t *testing.T) {
	bm := broadcastMsg{channelID: math.MaxInt64, senderID: math.MinInt64}
	var key string
	allocs := fewestAllocs(func() { key = topicLimiterKey(bm) })
	if allocs != 1 {
		t.Errorf("topicLimiterKey allocates %v times, want 1 (the key itself)", allocs)
	}
	if !strings.HasPrefix(key, "topic:channel:") {
		t.Errorf("key = %q", key)
	}
}

func BenchmarkTopicLimiterKey(b *testing.B) {
	bm := broadcastMsg{channelID: 1234567, senderID: 7654321}
	b.ReportAllocs()
	var key string
	for b.Loop() {
		key = topicLimiterKey(bm)
	}
	if key == "" {
		b.Fatal("empty key")
	}
}

// frameShapes is every way a frame's type field reaches the scanner: one clean frame per
// classified kind, then the shapes it must refuse.
func frameShapes() map[string][]byte {
	shapes := map[string][]byte{
		"missing type":        []byte(`{"seq":1,"channel_id":2}`),
		"empty payload":       nil,
		"empty type":          []byte(`{"type":""}`),
		"escaped type":        []byte(`{"type":"chat_message\"","payload":{}}`),
		"backslash in type":   []byte(`{"type":"chat\\_message"}`),
		"control char":        []byte("{\"type\":\"chat_message\x01\"}"),
		"unterminated type":   []byte(`{"type":"chat_message`),
		"65-byte type":        []byte(`{"type":"` + strings.Repeat("a", 65) + `"}`),
		"64-byte type":        []byte(`{"type":"` + strings.Repeat("a", 64) + `"}`),
		"unknown kind":        []byte(`{"type":"not_a_kind","payload":{}}`),
		"content kind nested": []byte(`{"type":"` + MsgTypePresence + `","payload":{"type":"` + MsgTypeChatMessage + `"}}`),
		"seq before type":     []byte(`{"seq":9,"type":"` + MsgTypeChatMessage + `","payload":{"channel_id":3}}`),
	}
	for kind := range contentBearingKinds {
		shapes["kind "+kind] = []byte(`{"type":"` + kind + `","payload":{"channel_id":3}}`)
	}
	return shapes
}

func TestFrameIsContentBearingMatchesTheStringLookup(t *testing.T) {
	want := map[string]bool{"seq before type": true}
	for kind, content := range contentBearingKinds {
		want["kind "+kind] = content
	}
	sawContent, sawMetadata := false, false
	for name, payload := range frameShapes() {
		before := string(payload)
		got := frameIsContentBearing(payload)
		if viaString := contentBearingKinds[extractEventType(payload)]; got != viaString {
			t.Errorf("%s: frameIsContentBearing = %v, the string lookup says %v", name, got, viaString)
		}
		if got != want[name] {
			t.Errorf("%s: frameIsContentBearing = %v, want %v", name, got, want[name])
		}
		if string(payload) != before {
			t.Errorf("%s: the scan changed the frame", name)
		}
		sawContent = sawContent || got
		sawMetadata = sawMetadata || (strings.HasPrefix(name, "kind ") && !got)
	}
	if !sawContent || !sawMetadata {
		t.Fatalf("the kind table gave content=%v metadata=%v, want both", sawContent, sawMetadata)
	}
}

// eventTypeBytes hands back a view into the frame, so the string form must be a copy that
// a later write to the frame cannot change.
func TestExtractEventTypeCopiesOutOfTheFrame(t *testing.T) {
	payload := []byte(`{"type":"` + MsgTypeChatMessage + `"}`)
	got := extractEventType(payload)
	for i := range payload {
		payload[i] = 'x'
	}
	if got != MsgTypeChatMessage {
		t.Errorf("extractEventType = %q after the frame was overwritten, want %q", got, MsgTypeChatMessage)
	}
}

func TestFrameIsContentBearingDoesNotAllocate(t *testing.T) {
	for name, payload := range frameShapes() {
		var got bool
		allocs := fewestAllocs(func() { got = frameIsContentBearing(payload) })
		if allocs != 0 {
			t.Errorf("%s: frameIsContentBearing allocates %v times (result %v), want 0", name, allocs, got)
		}
	}
}

func BenchmarkFrameIsContentBearing(b *testing.B) {
	payload := []byte(`{"type":"` + MsgTypeChatMessage + `","payload":{"channel_id":3,"content":"hello"}}`)
	b.ReportAllocs()
	got := false
	for b.Loop() {
		got = frameIsContentBearing(payload)
	}
	if !got {
		b.Fatal("a chat message is content-bearing")
	}
}

// entriesBuiltSeparately is how a user's entries for one channel were built before they
// were appended straight into the caller's slice: a slice of their own, then the forum
// mark stamped on afterwards.
func entriesBuiltSeparately(
	h *Hub, uid, chID int64, pc *pendingChannel, mentions []activityMention, blockers map[int64]map[int64]bool, withhold, forum bool,
) []channelActivityEntry {
	var entries []channelActivityEntry
	status, haveStatus := "", false
	for _, m := range mentions {
		if m.authorID == uid || blockers[m.authorID][uid] {
			continue
		}
		if m.everyone && m.hereOnly && !haveStatus {
			status, haveStatus = h.LiveStatus(uid), true
		}
		direct, broad := service.MentionReachSet(m.idSet, m.everyone, m.hereOnly, uid, status)
		if direct || broad {
			entries = append(entries, activityEntry(chID, m.msgID, m.authorID, direct, broad, withhold))
			break
		}
	}
	if len(entries) == 0 || entries[0].MessageID < pc.latestID {
		entries = append(entries, activityEntry(chID, pc.latestID, pc.latestAuthorID, false, false, withhold))
	}
	for i := range entries {
		entries[i].forum = forum
	}
	return entries
}

// wantEntry is one expected entry, spelled without the pointer.
type wantEntry struct {
	msgID, authorID int64
	direct, broad   bool
}

func TestActivityUserEntriesMatchesTheSeparateBuild(t *testing.T) {
	const (
		reader, author, other, online = int64(10), int64(20), int64(30), int64(40)
		chID                          = int64(7)
	)
	h := &Hub{clients: map[int64][]*Client{}}
	onlineConn := &Client{userID: online}
	onlineConn.presence.Store(&livePresence{status: db.StatusOnline})
	h.clients[online] = []*Client{onlineConn}

	mention := func(msgID, authorID int64, ids ...int64) activityMention {
		return activityMention{msgID: msgID, authorID: authorID, ids: ids, idSet: service.MentionIDSet(ids)}
	}
	here := func(msgID, authorID int64) activityMention {
		return activityMention{msgID: msgID, authorID: authorID, idSet: service.MentionIDSet(nil), everyone: true, hereOnly: true}
	}
	everyone := func(msgID, authorID int64) activityMention {
		return activityMention{msgID: msgID, authorID: authorID, idSet: service.MentionIDSet(nil), everyone: true}
	}
	latest := &pendingChannel{latestID: 100, latestAuthorID: other}

	cases := []struct {
		name     string
		uid      int64
		pc       *pendingChannel
		mentions []activityMention // newest first, as activityMentions sorts them
		blockers map[int64]map[int64]bool
		want     []wantEntry
	}{
		{name: "no mention", uid: reader, pc: latest, want: []wantEntry{{msgID: 100, authorID: other}}},
		{
			name: "a mention older than the latest message", uid: reader, pc: latest,
			mentions: []activityMention{mention(90, author, reader)},
			want:     []wantEntry{{msgID: 90, authorID: author, direct: true}, {msgID: 100, authorID: other}},
		},
		{
			name: "a mention that is the latest message", uid: reader,
			pc:       &pendingChannel{latestID: 100, latestAuthorID: author},
			mentions: []activityMention{mention(100, author, reader)},
			want:     []wantEntry{{msgID: 100, authorID: author, direct: true}},
		},
		{
			name: "a mention above the latest id", uid: reader, pc: latest,
			mentions: []activityMention{mention(101, author, reader)},
			want:     []wantEntry{{msgID: 101, authorID: author, direct: true}},
		},
		{
			name: "a blocked author's mention is passed over for an older one", uid: reader, pc: latest,
			mentions: []activityMention{mention(95, author, reader), mention(80, other, reader)},
			blockers: map[int64]map[int64]bool{author: {reader: true}},
			want:     []wantEntry{{msgID: 80, authorID: other, direct: true}, {msgID: 100, authorID: other}},
		},
		{
			name: "only a blocked author's mention", uid: reader, pc: latest,
			mentions: []activityMention{mention(95, author, reader)},
			blockers: map[int64]map[int64]bool{author: {reader: true}},
			want:     []wantEntry{{msgID: 100, authorID: other}},
		},
		{
			name: "the user's own mention", uid: reader, pc: latest,
			mentions: []activityMention{mention(95, reader, reader)},
			want:     []wantEntry{{msgID: 100, authorID: other}},
		},
		{
			name: "only the newest mention is kept", uid: reader, pc: latest,
			mentions: []activityMention{mention(95, author, reader), mention(90, other, reader)},
			want:     []wantEntry{{msgID: 95, authorID: author, direct: true}, {msgID: 100, authorID: other}},
		},
		{
			name: "a mention of someone else", uid: reader, pc: latest,
			mentions: []activityMention{mention(95, author, other)},
			want:     []wantEntry{{msgID: 100, authorID: other}},
		},
		{
			name: "everyone", uid: reader, pc: latest,
			mentions: []activityMention{everyone(95, author)},
			want:     []wantEntry{{msgID: 95, authorID: author, broad: true}, {msgID: 100, authorID: other}},
		},
		{
			name: "here does not reach an offline user", uid: reader, pc: latest,
			mentions: []activityMention{here(95, author), mention(90, author, reader)},
			want:     []wantEntry{{msgID: 90, authorID: author, direct: true}, {msgID: 100, authorID: other}},
		},
		{
			name: "here reaches an online user", uid: online, pc: latest,
			mentions: []activityMention{here(95, author)},
			want:     []wantEntry{{msgID: 95, authorID: author, broad: true}, {msgID: 100, authorID: other}},
		},
	}
	for _, tc := range cases {
		for _, withhold := range []bool{false, true} {
			for _, forum := range []bool{false, true} {
				name := tc.name + map[bool]string{true: ", author withheld"}[withhold] + map[bool]string{true: ", forum"}[forum]
				t.Run(name, func(t *testing.T) {
					got := h.activityUserEntries(nil, tc.uid, chID, tc.pc, tc.mentions, tc.blockers, withhold, forum)
					old := entriesBuiltSeparately(h, tc.uid, chID, tc.pc, tc.mentions, tc.blockers, withhold, forum)
					if !reflect.DeepEqual(got, old) {
						t.Errorf("entries differ from the separate build:\n got %s\n old %s", describeEntries(got), describeEntries(old))
					}
					checkEntries(t, got, chID, tc.want, withhold, forum)

					// Appending into a slice that already holds another channel's entries
					// keeps them and adds the same ones after.
					earlier := activityEntry(chID+1, 5, other, false, false, false)
					joined := h.activityUserEntries([]channelActivityEntry{earlier}, tc.uid, chID, tc.pc, tc.mentions, tc.blockers, withhold, forum)
					if len(joined) != len(got)+1 || !reflect.DeepEqual(joined[0], earlier) || !reflect.DeepEqual(joined[1:], got) {
						t.Errorf("appending after an earlier entry gave %s", describeEntries(joined))
					}
				})
			}
		}
	}
}

func checkEntries(t *testing.T, got []channelActivityEntry, chID int64, want []wantEntry, withhold, forum bool) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d entries %s, want %d", len(got), describeEntries(got), len(want))
	}
	for i, w := range want {
		e := got[i]
		if e.ChannelID != chID || e.MessageID != w.msgID || e.MentionsYou != w.direct || e.MentionsEveryone != w.broad || e.forum != forum {
			t.Errorf("entry %d = %s, want message %d direct=%v broad=%v forum=%v", i, describeEntries(got[i:i+1]), w.msgID, w.direct, w.broad, forum)
		}
		switch {
		case withhold && e.AuthorID != nil:
			t.Errorf("entry %d names author %d, want it withheld", i, *e.AuthorID)
		case !withhold && (e.AuthorID == nil || *e.AuthorID != w.authorID):
			t.Errorf("entry %d author = %v, want %d", i, e.AuthorID, w.authorID)
		}
	}
	// Each entry owns its author id: two entries must not share one variable.
	if len(got) == 2 && got[0].AuthorID != nil && got[0].AuthorID == got[1].AuthorID {
		t.Error("both entries point at the same author id")
	}
}

func describeEntries(entries []channelActivityEntry) string {
	var b strings.Builder
	for _, e := range entries {
		author := "withheld"
		if e.AuthorID != nil {
			author = strconv.FormatInt(*e.AuthorID, 10)
		}
		b.WriteString("{ch " + strconv.FormatInt(e.ChannelID, 10) + " msg " + strconv.FormatInt(e.MessageID, 10) +
			" author " + author + " you=" + strconv.FormatBool(e.MentionsYou) +
			" everyone=" + strconv.FormatBool(e.MentionsEveryone) + " forum=" + strconv.FormatBool(e.forum) + "}")
	}
	return b.String()
}
