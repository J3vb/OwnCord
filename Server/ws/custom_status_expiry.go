package ws

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/service"
)

// visibleCustomStatus is the publish guard for a custom status line that may predate
// its own clear: it returns text while expiresAt (a dbtime.ISOLayout instant, "" for
// none) is ahead of now, else nil. An unparseable expiry keeps the text, since
// nothing can say it ended. The expirer clears the row about a second after the
// instant, so every place a status leaves the server from a source that may not
// have seen that clear applies this.
func visibleCustomStatus(text *string, expiresAt string, now time.Time) *string {
	if text == nil || expiresAt == "" {
		return text
	}
	at, err := time.Parse(dbtime.ISOLayout, expiresAt)
	if err != nil {
		return text
	}
	if !now.Before(at) {
		return nil
	}
	return text
}

// storedCustomStatus is a user's custom status line and expiry tag (the
// db.User fields, passed apart so this file stays off the db import), with the
// publish guard applied: nil text and an empty tag once it has expired.
func storedCustomStatus(text, expiresAt *string, now time.Time) (visible *string, tag string) {
	if expiresAt != nil {
		tag = *expiresAt
	}
	visible = visibleCustomStatus(text, tag, now)
	if visible == nil {
		return nil, ""
	}
	return visible, tag
}

// customStatusExpiredLookupHook runs between CustomStatusExpired's client
// lookup and presenceMu. Test-only (always nil in production).
var customStatusExpiredLookupHook func(*Hub)

// CustomStatusExpired is the expirer's hook (service.CustomStatusNotifier): the
// custom status of userID that carried expiresAt was just cleared in the database. A
// connection still showing it drops it and everyone is told the status is null; a
// connection showing a newer one, or none, is left alone.
//
// It takes presenceMu itself rather than through dropQueuedPresenceAndBroadcast,
// whose drop is unconditional: a stale tag must leave a queued connect presence
// alone.
//
// Lock order: presenceMu, then h.mu (read, to confirm c is still the registered
// client; nothing takes presenceMu while holding h.mu), then the client's atomic
// presence pointer, then Client.mu (sendPresenceMsg, for the self half of an
// invisible split), then the presenceResyncMu/presenceRepair leaf. Nothing takes
// presenceMu while holding Client.mu (sendPresenceMsg releases c.mu before
// presenceDropped), and there is no DB I/O under presenceMu, so this adds no edge.
// The compare-and-swap runs under presenceMu, and a presence_update stores its live
// presence before it emits, so a racing set either swaps the pointer first (the tag
// no longer matches and nothing is sent) or emits after this frame with newer text.
func (h *Hub) CustomStatusExpired(userID int64, expiresAt string) {
	conns := h.clientsOf(userID)
	if len(conns) == 0 {
		return
	}
	if customStatusExpiredLookupHook != nil {
		customStatusExpiredLookupHook(h)
	}
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	// A same-session reconnect may have replaced a connection since the
	// lookup; re-read so only live ones are cleared (the replacement carries
	// its own presence and its own tag).
	conns = h.clientsOf(userID)
	if len(conns) == 0 {
		return
	}
	// The user's shown presence is the most recent setter's. The expiry is
	// announced only when that is the status that expired; any connection
	// still carrying the expired tag is cleared either way.
	shown := mergeLivePresence(conns)
	announce := shown.customStatus != nil && shown.customStatusExpiresAt == expiresAt
	var first *Client
	for _, c := range conns {
		cur := c.presence.Load()
		if cur == nil || cur.customStatus == nil || cur.customStatusExpiresAt != expiresAt {
			continue
		}
		if c.presence.CompareAndSwap(cur, &livePresence{status: cur.status, idleSince: cur.idleSince, setAt: cur.setAt, activity: cur.activity, listening: cur.listening}) && first == nil {
			first = c
		}
	}
	if !announce || first == nil {
		// Not the status that expired: no frame, and the queued connect
		// presence (if any) is still owed, so it is not dropped either.
		return
	}
	// Like every user-chosen presence, this supersedes a queued connect entry.
	h.dropQueuedPresenceLocked(userID)
	for _, ev := range presenceEvents(userID, shown.status, nil, shown.activity, shown.listening) {
		h.enqueueExpiredPresence(first, ev)
	}
}

// enqueueExpiredPresence enqueues one half of an expired status's presence the way
// emitEventsFrom does. CustomStatusExpired already holds presenceMu, so the only
// further locks are the non-blocking enqueues' own: Client.mu in sendPresenceMsg
// (released before presenceDropped), then the presenceResyncMu/presenceRepair leaf.
func (h *Hub) enqueueExpiredPresence(c *Client, ev Event) {
	switch e := ev.(type) {
	case PresenceEvent:
		h.broadcastPresenceFrame(0, e.Payload())
	case PresenceOthersEvent:
		h.broadcastPresenceFrame(c.userID, e.Payload())
	case PresenceSelfEvent:
		c.sendPresenceMsg(e.Payload())
	}
}

// parseCustomStatusExpiresIn reads presence_update's optional
// custom_status_expires_in: a plain JSON integer of
// service.MinCustomStatusExpirySeconds to service.MaxCustomStatusExpirySeconds,
// valid only alongside a non-empty custom_status. A string, a fraction, an
// exponent or an out-of-range value is an error (BAD_REQUEST). Absent and null
// both mean "no expiry".
func parseCustomStatusExpiresIn(raw json.RawMessage, customStatus *string) (*int64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	n, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("custom_status_expires_in must be an integer: %w", err)
	}
	if n < service.MinCustomStatusExpirySeconds || n > service.MaxCustomStatusExpirySeconds {
		return nil, fmt.Errorf("custom_status_expires_in must be %d to %d seconds",
			service.MinCustomStatusExpirySeconds, service.MaxCustomStatusExpirySeconds)
	}
	if customStatus == nil || strings.TrimSpace(*customStatus) == "" {
		return nil, fmt.Errorf("custom_status_expires_in needs a non-empty custom_status")
	}
	return &n, nil
}

// parsePresenceUpdate builds a PresenceUpdateCmd from a presence_update payload.
func parsePresenceUpdate(userID int64, raw json.RawMessage) (Command, error) {
	var p struct {
		Status       string          `json:"status"`
		CustomStatus *string         `json:"custom_status"`
		ExpiresIn    json.RawMessage `json:"custom_status_expires_in"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid presence_update payload: %w", err)
	}
	expiresIn, err := parseCustomStatusExpiresIn(p.ExpiresIn, p.CustomStatus)
	if err != nil {
		return nil, err
	}
	return PresenceUpdateCmd{userID: userID, Status: p.Status, CustomStatus: p.CustomStatus, ExpiresIn: expiresIn}, nil
}
