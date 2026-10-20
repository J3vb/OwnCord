package ws

// carriesChatState reports whether a channel of type t keeps per-user unread
// and mention state: the channels ready gives an unread_count and the
// activity hint covers. A voice channel has a text chat beside its call, so it
// counts like a text channel. DMs are handled separately (their participants
// get the sequenced chat_message).
func carriesChatState(t string) bool {
	switch t {
	case "text", "announcement", "voice":
		return true
	default:
		return false
	}
}
