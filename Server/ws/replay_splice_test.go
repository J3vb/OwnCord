package ws

import (
	"bytes"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

func replyFrameForTest() []byte {
	parent := int64(100)
	return buildChatMessage(chatMessageArgs{
		MsgID: 300, ChannelID: 7, UserID: 2, Username: "u", RoleName: "member",
		Content: "the <reply> & more", Timestamp: "2026-10-17T00:00:00Z",
		ReplyTo: &parent,
		ReferencedMessage: &service.ReferencedMessage{
			ID: 100, Content: "secret <parent> text",
		},
	})
}

// The split replay copy (SV-04) must be byte-identical to the one the hub
// stored while it held seqMu: replayCopy of the wrapped frame. The live bytes
// are wrapWithSeq, unchanged, and keep the snippet.
func TestStoredCopy_MatchesReplayCopyOfWrapped(t *testing.T) {
	frames := map[string][]byte{
		"reply":      replyFrameForTest(),
		"plain":      []byte(`{"type":"chat_message","payload":{"id":1,"referenced_message":null}}`),
		"no-payload": []byte(`{"type":"x","referenced_message":{"a":1}}`),
		"extra-keys": []byte(`{"zeta":1,"alpha":2,"type":"t","payload":{"referenced_message":{"id":1},"content":"<&>"}}`),
		"malformed":  []byte(`{"payload":{"referenced_message":{"id":1}`),
		"not-object": []byte(`["referenced_message":{]`),
		"oversized":  []byte(`{"payload":{"referenced_message":{"x":"` + strings.Repeat("a", config.MaxMessageBytes) + `"}}}`),
	}
	for name, msg := range frames {
		for _, seq := range []uint64{1, 42, 18446744073709551615} {
			wrapped := wrapWithSeq(msg, seq)
			want := replayCopy(wrapped)
			got := storedCopy(newReplaySplice(msg), msg, wrapped, seq)
			if !bytes.Equal(got, want) {
				t.Errorf("%s seq=%d: stored copy diverged\n got: %.200s\nwant: %.200s", name, seq, got, want)
			}
		}
	}
}

func TestStoredCopy_ReplyFrameStoredAndLive(t *testing.T) {
	msg := replyFrameForTest()
	wrapped := wrapWithSeq(msg, 9)
	stored := storedCopy(newReplaySplice(msg), msg, wrapped, 9)

	if !bytes.Contains(wrapped, []byte("secret")) || bytes.Contains(wrapped, []byte(`"referenced_message":null`)) {
		t.Fatalf("live frame lost its snippet: %s", wrapped)
	}
	if bytes.Contains(stored, []byte("secret")) || !bytes.Contains(stored, []byte(`"referenced_message":null`)) {
		t.Fatalf("stored frame kept the snippet: %s", stored)
	}
	if !bytes.Contains(stored, []byte(`"seq":9,`)) && !bytes.Contains(stored, []byte(`"seq":9}`)) {
		t.Fatalf("stored frame lost its seq: %s", stored)
	}
	// A frame without a snippet is stored as the live bytes themselves.
	plain := []byte(`{"type":"typing","payload":{"channel_id":1}}`)
	pw := wrapWithSeq(plain, 3)
	if got := storedCopy(newReplaySplice(plain), plain, pw, 3); !bytes.Equal(got, pw) {
		t.Fatalf("snippet-free frame must be stored unchanged: %s", got)
	}
}
