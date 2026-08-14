package ws

import "testing"

// dmEventOrFallback guards the degraded-fan-out shape: a DM event whose
// participant list is empty (a failed post-commit participant lookup) must
// fall back to the channel-topic broadcast instead of consuming a seq for a
// frame addressed to nobody — the topic fallback still reaches whoever has
// the DM focused.
func TestDMEventOrFallback(t *testing.T) {
	dm := MessageSentDMEvent{channelID: 5}
	fb := MessageSentChannelEvent{channelID: 5}
	if _, ok := dmEventOrFallback(dm, fb, nil).(MessageSentChannelEvent); !ok {
		t.Error("empty participant list must fall back to the channel broadcast")
	}
	if _, ok := dmEventOrFallback(dm, fb, []int64{1, 2}).(MessageSentDMEvent); !ok {
		t.Error("a populated participant list must keep the DM-targeted event")
	}
}
