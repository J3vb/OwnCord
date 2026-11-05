package ws

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// password_protected rides the ready snapshot and the channel_create /
// channel_update broadcasts, false included. The hash is not a field of the
// channel row at all, so no payload can carry it.
func TestChannelPayload_CarriesJoinLocked(t *testing.T) {
	channels := []db.Channel{
		{ID: 1, Name: "locked", Type: "voice", JoinLocked: true},
		{ID: 2, Name: "open", Type: "voice"},
	}

	requireFlagOnEveryChannelPayload(t, "password_protected", channels)
}
