package ws

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// password_protected rides the ready snapshot and the channel_create /
// channel_update broadcasts, false included. The hash is not a field of the
// channel row at all, so no payload can carry it.
func TestChannelPayload_CarriesJoinLocked(t *testing.T) {
	channels := []db.Channel{
		{ID: 1, Name: "locked", Type: "voice", JoinLocked: true},
		{ID: 2, Name: "open", Type: "voice"},
	}

	ready := readyChannelPayloads(channels, permissions.MemberGrants{}, nil, nil, false, service.ChannelPrivacySnapshot{})
	for i, want := range []bool{true, false} {
		got, present := ready[i]["password_protected"]
		if !present || got != want {
			t.Errorf("ready channel %d password_protected = %v (present %v), want %v", channels[i].ID, got, present, want)
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
			got, present := env.Payload["password_protected"]
			if !present || got != want {
				t.Errorf("%s for channel %d password_protected = %v (present %v), want %v", name, channels[i].ID, got, present, want)
			}
		}
	}
}
