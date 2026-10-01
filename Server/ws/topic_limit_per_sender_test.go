package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// The channel topic limit is counted per sender: a few members each sending
// chat, edits and reactions at their own per-user caps add up past the
// channel's limit, and every other member must still receive their frames live.
func TestTopicLimit_PerSender_FifthUserReceivesEveryFrame(t *testing.T) {
	h := newEmitTestHub()
	const chID = 7
	send := make(chan []byte, 1024)
	c := NewTestClientWithChannel(h, 5, chID, send)
	h.clients[5] = c
	h.pubsub.Subscribe(c, ChannelTopic(chID))

	// chat 10/s + edit 10/s + delete 10/s + reactions 5/s per sender.
	const perSender = 35
	ctx := context.Background()
	for sender := int64(1); sender <= 4; sender++ {
		for i := range perSender {
			kind := MsgTypeChatMessage // content-bearing path
			if i%2 == 1 {
				kind = MsgTypeChatDeleted // metadata path
			}
			payload := fmt.Appendf(nil, `{"type":%q,"payload":{"channel_id":%d}}`, kind, chID)
			h.emitEventsFrom(ctx, sender, []Event{channelEvt{evType: kind, channelID: chID, payload: payload}})
			h.deliverBroadcast(<-h.broadcast)
		}
	}

	got := 0
	for len(send) > 0 {
		var env struct {
			Seq uint64 `json:"seq"`
		}
		if json.Unmarshal(<-send, &env) == nil && env.Seq != 0 {
			got++
		}
	}
	if want := 4 * perSender; got != want {
		t.Fatalf("subscriber received %d of %d frames (topic sheds %d)", got, want, h.TopicShedCount())
	}
}
