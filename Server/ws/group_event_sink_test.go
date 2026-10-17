package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

func groupRow(f *callSinkFixture, id int64, kind string, target int64, name *string) service.GroupEventRow {
	return service.GroupEventRow{
		MessageID: id, Kind: kind, Author: f.alice, AuthorRole: "Owner",
		Content: "fallback sentence.", Timestamp: "2026-10-17 10:00:00",
		TargetUserID: target, Name: name,
	}
}

func TestGroupEventSink_SequencedAndReplayedToAudience(t *testing.T) {
	f := newCallSinkFixture(t)
	name := "Raid night"
	rows := []service.GroupEventRow{
		groupRow(f, 81, "group_add", f.bob.ID, nil),
		groupRow(f, 82, "group_remove", f.bob.ID, nil),
		groupRow(f, 83, "group_leave", 0, nil),
		groupRow(f, 84, "group_rename", 0, &name),
	}
	f.hub.GroupEventRows(context.Background(), f.dm, []int64{f.alice.ID, f.bob.ID}, rows)

	want := map[int64]string{
		81: `{"target_user_id":%d}`,
		82: `{"target_user_id":%d}`,
		83: `{}`,
		84: `{"name":"Raid night"}`,
	}
	for who, ch := range map[string]chan []byte{"alice": f.aliceSend, "bob": f.bobSend} {
		frames := callFrames(ch, 300*time.Millisecond)
		if len(frames) != len(rows) {
			t.Fatalf("%s got %d frames, want %d", who, len(frames), len(rows))
		}
		var prev uint64
		for i, fr := range frames {
			if frameType(fr) != "chat_message" {
				t.Fatalf("%s frame %d type = %s", who, i, frameType(fr))
			}
			var seq uint64
			if err := json.Unmarshal(fr["seq"], &seq); err != nil || seq == 0 || seq <= prev {
				t.Errorf("%s frame %d seq = %s after %d, want increasing", who, i, fr["seq"], prev)
			}
			prev = seq
			var pl struct {
				ID               int64           `json:"id"`
				Kind             string          `json:"kind"`
				Content          string          `json:"content"`
				Mentions         []int64         `json:"mentions"`
				MentionsEveryone bool            `json:"mentions_everyone"`
				GroupEvent       json.RawMessage `json:"group_event"`
				Call             json.RawMessage `json:"call"`
				User             struct {
					ID int64 `json:"id"`
				} `json:"user"`
			}
			if err := json.Unmarshal(fr["payload"], &pl); err != nil {
				t.Fatal(err)
			}
			if pl.ID != rows[i].MessageID || pl.Kind != rows[i].Kind || pl.Content != "fallback sentence." || pl.User.ID != f.alice.ID {
				t.Errorf("%s frame %d = %+v", who, i, pl)
			}
			if len(pl.Mentions) != 0 || pl.MentionsEveryone || pl.Call != nil {
				t.Errorf("%s frame %d carries mentions or a call block: %+v", who, i, pl)
			}
			expect := want[pl.ID]
			if pl.ID <= 82 {
				expect = fmt.Sprintf(expect, f.bob.ID)
			}
			if string(pl.GroupEvent) != expect {
				t.Errorf("%s row %d group_event = %s, want %s", who, pl.ID, pl.GroupEvent, expect)
			}
		}
	}
	if frames := callFrames(f.outsSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("a user outside the audience received %d frames", len(frames))
	}

	var held int
	for _, frame := range f.hub.ReplayBuffer().AllFramesForTest() {
		if bytes.Contains(frame, []byte(`"group_event"`)) {
			held++
		}
	}
	if held != len(rows) {
		t.Errorf("replay ring holds %d group rows, want %d", held, len(rows))
	}
}

func TestGroupEventSink_EmptyAudienceOrRowsSendsNothing(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.GroupEventRows(context.Background(), f.dm, nil, []service.GroupEventRow{groupRow(f, 90, "group_leave", 0, nil)})
	f.hub.GroupEventRows(context.Background(), f.dm, []int64{f.alice.ID}, nil)
	if frames := callFrames(f.aliceSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("got %d frames, want none", len(frames))
	}
}
