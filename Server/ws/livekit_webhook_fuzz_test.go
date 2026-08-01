package ws

import (
	"strconv"
	"strings"
	"testing"
)

// FuzzParseParticipantIdentity checks parseParticipantIdentity, which parses
// an untrusted LiveKit webhook participant identity of the form
// "user-{id}" or "user-{id}:{joinToken}". Invariant: it never panics on any
// input, and on success the returned (userID, joinToken) are exactly what
// the "user-" + strconv.ParseInt + strings.Cut(":") pipeline the source uses
// would produce — i.e. identity must start with "user-", and the ID part
// (up to the first ':') must parse as the returned userID with the returned
// joinToken being everything after that first ':' (or "" if none).
func FuzzParseParticipantIdentity(f *testing.F) {
	seeds := []string{
		"",
		"user-",
		"user-1",
		"user-1:tok",
		"user-1:tok:extra:colons",
		"user--1",
		"user-9223372036854775807",  // max int64
		"user-9223372036854775808",  // overflow
		"user--9223372036854775808", // min int64
		"user-abc",
		"user-1abc",
		"user-1 ",
		"USER-1",
		"user-1\x00:tok",
		"user-1:",
		"user-:tok",
		"not-a-user",
		"user",
		"user-0",
		"user-+1",
		"user-01",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, identity string) {
		userID, joinToken, err := parseParticipantIdentity(identity)
		if err != nil {
			return
		}

		if !strings.HasPrefix(identity, "user-") {
			t.Fatalf("parseParticipantIdentity(%q) = (%d,%q,nil), but input lacks the required user- prefix", identity, userID, joinToken)
		}
		body := identity[len("user-"):]
		idPart, wantJoinToken, _ := strings.Cut(body, ":")

		wantUserID, perr := strconv.ParseInt(idPart, 10, 64)
		if perr != nil {
			t.Fatalf("parseParticipantIdentity(%q) = (%d,%q,nil), but the id part %q does not itself parse as int64: %v", identity, userID, joinToken, idPart, perr)
		}
		if wantUserID != userID {
			t.Fatalf("parseParticipantIdentity(%q) = userID %d, want %d (parsed from id part %q)", identity, userID, wantUserID, idPart)
		}
		if wantJoinToken != joinToken {
			t.Fatalf("parseParticipantIdentity(%q) = joinToken %q, want %q", identity, joinToken, wantJoinToken)
		}
	})
}

// FuzzParseRoomChannelID checks parseRoomChannelID, which parses an
// untrusted LiveKit webhook room name of the form "channel-{id}". Invariant:
// it never panics on any input, and on success the input must start with
// "channel-" and the remainder must parse as the returned channelID.
func FuzzParseRoomChannelID(f *testing.F) {
	seeds := []string{
		"",
		"channel-",
		"channel-1",
		"channel--1",
		"channel-9223372036854775807",
		"channel-9223372036854775808",
		"channel--9223372036854775808",
		"channel-abc",
		"channel-1abc",
		"CHANNEL-1",
		"not-a-channel",
		"channel",
		"channel-0",
		"channel-+1",
		"channel-01",
		"channel-1\x00",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, roomName string) {
		channelID, err := parseRoomChannelID(roomName)
		if err != nil {
			return
		}

		if !strings.HasPrefix(roomName, "channel-") {
			t.Fatalf("parseRoomChannelID(%q) = (%d,nil), but input lacks the required channel- prefix", roomName, channelID)
		}
		idPart := roomName[len("channel-"):]
		wantChannelID, perr := strconv.ParseInt(idPart, 10, 64)
		if perr != nil {
			t.Fatalf("parseRoomChannelID(%q) = (%d,nil), but the id part %q does not itself parse as int64: %v", roomName, channelID, idPart, perr)
		}
		if wantChannelID != channelID {
			t.Fatalf("parseRoomChannelID(%q) = %d, want %d (parsed from id part %q)", roomName, channelID, wantChannelID, idPart)
		}
	})
}
