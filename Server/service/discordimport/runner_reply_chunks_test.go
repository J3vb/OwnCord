package discordimport

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// With one message per chunk a reply and its target never share a chunk, so the link has to come from
// the ids kept between chunks.
func TestRun_ReplyAcrossChunksKeepsItsLink(t *testing.T) {
	h := newHarness(t, 1)
	job, res := h.run(h.fixtureZip())
	if res.Err != nil || res.Status != db.ImportDone {
		t.Fatalf("result = %+v", res)
	}
	msgs, err := h.database.GetMessages(context.Background(), job.ChannelID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	byContent := map[string]db.MessageWithUser{}
	for _, m := range msgs {
		byContent[m.Content] = m
	}
	first, reply := byContent["Hello world"], byContent["Hi back"]
	if reply.ReplyTo == nil || *reply.ReplyTo != first.ID {
		t.Errorf("reply link = %v, want %d", reply.ReplyTo, first.ID)
	}
	if loose := byContent["Replying to something not exported"]; loose.ReplyTo != nil {
		t.Errorf("a reply to a missing message kept link %v", *loose.ReplyTo)
	}
}
