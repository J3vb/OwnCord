package ws

// carriesChatState reports whether a channel type keeps per-user unread and
// mention state. Voice channels and threads count; DMs are handled separately.
func carriesChatState(t string) bool {
	switch t {
	case "text", "announcement", "voice", "thread":
		return true
	default:
		return false
	}
}
