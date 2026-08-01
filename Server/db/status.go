package db

// ─── Presence status vocabulary ─────────────────────────────────────────────
//
// `users.status` stores the status the user actually chose. "invisible" is one
// of those choices and is stored as itself — it is deliberately NOT collapsed
// to "offline" at the write, because the server has to be able to tell "chose
// to appear offline" from "is not connected" on the next connect (the first
// must survive a reconnect, the second must not).
//
// The collapse happens at every read that another user can see:
// BroadcastStatus maps invisible -> offline, and the owner's own payloads keep
// the true value. That split is the whole "real invisible" model — one place
// decides what others see, so a new payload cannot accidentally leak it.

const (
	// StatusOnline is the default presence for a connected session.
	StatusOnline = "online"
	// StatusIdle is set manually or by the client's inactivity timer.
	StatusIdle = "idle"
	// StatusDND suppresses desktop notifications client-side.
	StatusDND = "dnd"
	// StatusInvisible means "connected, but shown to everyone else as offline".
	StatusInvisible = "invisible"
	// StatusOffline means "not connected". It is no longer a status a user can
	// pick — StatusInvisible replaced that — but it is still what disconnect
	// writes and what BroadcastStatus maps invisible to.
	StatusOffline = "offline"
)

// ValidStatuses is the set a client may set via presence_update. "offline" is
// still accepted so an older client that sends it (the pre-invisible spelling
// of "appear offline") is not answered with an error; it is treated as the
// plain offline it says.
var ValidStatuses = map[string]bool{
	StatusOnline:    true,
	StatusIdle:      true,
	StatusDND:       true,
	StatusInvisible: true,
	StatusOffline:   true,
}

// BroadcastStatus maps a stored status to what OTHER users may see. Only
// invisible is rewritten; everything else is already public.
func BroadcastStatus(status string) string {
	if status == StatusInvisible {
		return StatusOffline
	}
	return status
}

// StatusForViewer returns the status `subjectID` should appear as to
// `viewerID`. The owner of a status always sees its true value — a client that
// was told it was offline would render its own picker wrong and re-send
// "online" on the next reconnect, which is exactly the flash-online bug real
// invisible exists to kill.
func StatusForViewer(status string, subjectID, viewerID int64) string {
	if subjectID == viewerID {
		return status
	}
	return BroadcastStatus(status)
}

// ConnectStatus returns the status a session should come online as, given the
// status saved from the user's last session.
//
// idle, dnd and invisible are deliberate choices and survive a reconnect;
// anything else (online, offline, or an unknown legacy value) becomes online.
// "offline" cannot be honoured here because it is also what a disconnect
// writes, so it carries no intent — that ambiguity is why invisible is its own
// value rather than a flag on offline.
func ConnectStatus(saved string) string {
	switch saved {
	case StatusIdle, StatusDND, StatusInvisible:
		return saved
	default:
		return StatusOnline
	}
}
