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

// visibleCustomStatus is the publish guard for a custom status that may predate
// its own clear: text while expiresAt (a dbtime.ISOLayout instant, "" for none)
// is ahead of now, else nil. An unparseable expiry keeps the text. The expirer
// clears the row about a second after the instant, so every path that may not
// have seen the clear applies this.
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

// storedCustomStatus applies the publish guard to a user's stored text and expiry
// tag (passed apart to keep this file off the db import).
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

// customStatusExpiredLookupHook runs between CustomStatusExpired's client lookup
// and presenceFeed.mu; test-only.
var customStatusExpiredLookupHook func(*Hub)

// CustomStatusExpired is the expirer's hook (service.CustomStatusNotifier): a
// connection still showing the cleared status drops it and everyone is told it is
// null; one showing a newer status, or none, is left alone.
// It takes presenceFeed.mu itself rather than dropQueuedPresenceAndBroadcast,
// whose drop is unconditional: a stale tag must leave a queued connect presence
// alone.
// Lock order: presenceFeed.mu, then h.mu (read, to confirm c is still
// registered), then the client's atomic presence pointer, then Client.mu
// (sendPresenceMsg), then the presenceResyncMu/presenceFeed.repair leaf. Nothing
// takes presenceFeed.mu under h.mu or Client.mu and there is no DB I/O under it,
// so this adds no edge. The compare-and-swap runs under presenceFeed.mu and
// presence_update stores before it emits, so a racing set either swaps first (the
// tag no longer matches) or emits after this frame with newer text.
func (h *Hub) CustomStatusExpired(userID int64, expiresAt string) {
	conns := h.clientsOf(userID)
	if len(conns) == 0 {
		return
	}
	if customStatusExpiredLookupHook != nil {
		customStatusExpiredLookupHook(h)
	}
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	// A same-session reconnect may have replaced a connection since the lookup;
	// re-read so only live ones are cleared.
	conns = h.clientsOf(userID)
	if len(conns) == 0 {
		return
	}
	// The expiry is announced only when the most recent setter's status is the
	// one that expired; any connection carrying the expired tag is cleared either
	// way.
	shown := mergeLivePresence(conns)
	announce := shown.customStatus != nil && shown.customStatusExpiresAt == expiresAt
	var first *Client
	for _, c := range conns {
		cur := c.presence.Load()
		if cur == nil || cur.customStatus == nil || cur.customStatusExpiresAt != expiresAt {
			continue
		}
		if c.presence.CompareAndSwap(cur, &livePresence{status: cur.status, idleSince: cur.idleSince, setAt: cur.setAt, activity: cur.activity, listening: cur.listening, selfIdle: cur.selfIdle}) && first == nil {
			first = c
		}
	}
	if !announce || first == nil {
		// Not the expired status: no frame, and a queued connect presence is
		// still owed.
		return
	}
	// Like every user-chosen presence, this supersedes a queued connect entry.
	h.dropQueuedPresenceLocked(userID)
	for _, ev := range presenceEvents(userID, shown.status, nil, shown.activity, shown.listening, shown.mobile) {
		h.enqueueExpiredPresence(first, ev)
	}
}

// enqueueExpiredPresence enqueues one half of an expired status's presence like
// emitEventsFrom. The caller holds presenceFeed.mu; the only further locks are
// the non-blocking enqueues' own (Client.mu in sendPresenceMsg, then the
// presenceResyncMu/presenceFeed.repair leaf).
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
// custom_status_expires_in: a plain JSON integer within
// service.MinCustomStatusExpirySeconds..MaxCustomStatusExpirySeconds, valid only
// with a non-empty custom_status. Anything else is BAD_REQUEST; absent and null
// mean no expiry.
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
