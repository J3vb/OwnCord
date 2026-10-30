package db

// users.status stores the status the user actually chose. "invisible" is
// stored as itself, not collapsed to "offline" at the write, because the server
// must tell "chose to appear offline" (survives a reconnect) from "is not
// connected" (does not). The collapse happens at every read another user can
// see: BroadcastStatus maps invisible to offline while the owner's own payloads
// keep the true value, so one place decides what others see and no new payload
// can leak it.

const (
	// StatusOnline is the default presence for a connected session.
	StatusOnline = "online"
	// StatusIdle is set manually or by the client's inactivity timer.
	StatusIdle = "idle"
	// StatusDND suppresses desktop notifications client-side.
	StatusDND = "dnd"
	// StatusInvisible means "connected, but shown to everyone else as offline".
	StatusInvisible = "invisible"
	// StatusOffline means "not connected". Users can no longer pick it
	// (StatusInvisible replaced that) but it is what disconnect writes and what
	// BroadcastStatus maps invisible to.
	StatusOffline = "offline"
)

// ValidStatuses is the set a client may set via presence_update. "offline" is
// still accepted so an older client sending the pre-invisible spelling of
// "appear offline" gets no error; it is treated as plain offline.
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

// StatusForViewer returns the status subjectID should appear as to viewerID.
// The owner always sees their true value: a client told it was offline would
// render its own picker wrong and re-send "online" on reconnect (the
// flash-online bug real invisible exists to kill).
func StatusForViewer(status string, subjectID, viewerID int64) string {
	if subjectID == viewerID {
		return status
	}
	return BroadcastStatus(status)
}

// ConnectStatus returns the status a session should come online as, given the
// status saved from the last session. idle, dnd and invisible are deliberate
// choices and survive a reconnect; anything else (online, offline, unknown
// legacy value) becomes online. "offline" carries no intent because a
// disconnect also writes it, which is why invisible is its own value.
func ConnectStatus(saved string) string {
	switch saved {
	case StatusIdle, StatusDND, StatusInvisible:
		return saved
	default:
		return StatusOnline
	}
}
