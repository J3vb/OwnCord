package db

// users.status stores the status the user actually chose. "invisible" is
// stored as itself, not collapsed to "offline", because the server must tell
// "chose to appear offline" (survives a reconnect) from "not connected". The
// collapse happens at every read another user can see (BroadcastStatus), so one
// place decides what others see and no new payload can leak it.

const (
	// StatusOnline is the default presence for a connected session.
	StatusOnline = "online"
	// StatusIdle is set manually or by the client's inactivity timer.
	StatusIdle = "idle"
	// StatusDND suppresses desktop notifications client-side.
	StatusDND = "dnd"
	// StatusInvisible means "connected, but shown to everyone else as offline".
	StatusInvisible = "invisible"
	// StatusOffline means "not connected": users can no longer pick it, but disconnect
	// writes it and BroadcastStatus maps invisible to it.
	StatusOffline = "offline"
)

// ValidStatuses is the set a client may set via presence_update; "offline" is still
// accepted so an older client sending the pre-invisible spelling gets no error.
var ValidStatuses = map[string]bool{
	StatusOnline:    true,
	StatusIdle:      true,
	StatusDND:       true,
	StatusInvisible: true,
	StatusOffline:   true,
}

// BroadcastStatus maps a stored status to what OTHER users may see; only invisible is rewritten.
func BroadcastStatus(status string) string {
	if status == StatusInvisible {
		return StatusOffline
	}
	return status
}

// StatusForViewer returns the status subjectID should appear as to viewerID; the owner
// always sees their true value, or their own picker would render wrong and re-send
// "online" on reconnect.
func StatusForViewer(status string, subjectID, viewerID int64) string {
	if subjectID == viewerID {
		return status
	}
	return BroadcastStatus(status)
}

// ConnectStatus returns the status a session comes online as: idle, dnd and invisible
// survive a reconnect, anything else becomes online ("offline" carries no intent: a
// disconnect also writes it).
func ConnectStatus(saved string) string {
	switch saved {
	case StatusIdle, StatusDND, StatusInvisible:
		return saved
	default:
		return StatusOnline
	}
}
