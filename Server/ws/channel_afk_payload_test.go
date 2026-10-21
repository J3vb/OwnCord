package ws

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// The afk flag rides every channel payload the client already receives: the
// ready snapshot and the channel_create / channel_update broadcasts. It is
// always sent, false included, so "absent" never has to mean two things.
func TestChannelPayload_CarriesAFK(t *testing.T) {
	channels := []db.Channel{
		{ID: 1, Name: "lounge", Type: "voice", AFK: true},
		{ID: 2, Name: "general", Type: "voice"},
	}

	ready := readyChannelPayloads(channels, permissions.MemberGrants{}, nil, nil, false, service.ChannelPrivacySnapshot{})
	for i, want := range []bool{true, false} {
		got, present := ready[i]["afk"]
		if !present {
			t.Fatalf("ready channel %d omits afk", channels[i].ID)
		}
		if got != want {
			t.Errorf("ready channel %d afk = %v, want %v", channels[i].ID, got, want)
		}
	}

	for name, build := range map[string]func(*db.Channel) []byte{
		"channel_update": func(ch *db.Channel) []byte { return buildChannelUpdate(ch, false) },
		"channel_create": func(ch *db.Channel) []byte { return buildChannelCreateFor(ch, false, channelAffordances{}) },
	} {
		for i, want := range []bool{true, false} {
			var env struct {
				Payload map[string]any `json:"payload"`
			}
			if err := json.Unmarshal(build(&channels[i]), &env); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			got, present := env.Payload["afk"]
			if !present {
				t.Fatalf("%s for channel %d omits afk", name, channels[i].ID)
			}
			if got != want {
				t.Errorf("%s for channel %d afk = %v, want %v", name, channels[i].ID, got, want)
			}
		}
	}
}
