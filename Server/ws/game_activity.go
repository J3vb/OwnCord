package ws

// The game a member is playing, reported by activity_update and shown on presence,
// presence_batch and ready.activities. Memory only (Client.presence.activity): no
// table, cleared by a disconnect or restart.

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

const (
	// activityRateLimit and activityRateWindow bound how often a connection may set
	// (not clear) its activity: 1 per 10 s, on its own budget so the client's auto-idle
	// presence_update is never starved by a game start.
	activityRateLimit  = 1
	activityRateWindow = 10 * time.Second
	// activityMaxAge is how far back started_at may reach.
	activityMaxAge = 24 * time.Hour
)

// gameActivity is a connection's reported game. Immutable once published (a change
// swaps in a new value); the json tags are the wire shape for presence payloads and
// ready.activities.
type gameActivity struct {
	Name      string `json:"name"`
	StartedAt int64  `json:"started_at"` // unix milliseconds
}

// sameActivity reports whether a and b are the same game at the same start. The
// handler's no-op check compares names only (sameGame); this exact form is the
// applier's guard against re-broadcasting the value it holds.
func sameActivity(a, b *gameActivity) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// sameGame reports whether next names the game cur already shows. A repeat keeps
// cur's start: the client re-sends after every reconnect and a start older than
// activityMaxAge clamps to a moving bound, so comparing starts would rebroadcast a
// long session on every poll.
func sameGame(cur, next *gameActivity) bool {
	return cur != nil && next != nil && cur.Name == next.Name
}

// activityChange is Result.SetActivity: the activity to swap in, nil to clear.
type activityChange struct {
	next *gameActivity
}

// ActivityUpdateCmd is an activity_update message. Clear is set for "activity": null
// and for a name empty after trimming; otherwise Name is the cleaned name and
// StartedAt the client's unix ms, not yet clamped (the handler does that).
type ActivityUpdateCmd struct {
	userID    int64
	Clear     bool
	Name      string
	StartedAt int64
}

func (c ActivityUpdateCmd) Type() string  { return MsgTypeActivityUpdate }
func (c ActivityUpdateCmd) UserID() int64 { return c.userID }

// parseActivityUpdate builds an ActivityUpdateCmd. A missing field, wrong JSON type,
// non-integer started_at or a name failing the custom status text rules is a
// BAD_REQUEST error.
func parseActivityUpdate(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		Activity json.RawMessage `json:"activity"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid activity_update payload: %w", err)
	}
	if len(p.Activity) == 0 {
		return nil, fmt.Errorf("invalid activity_update payload: activity is required")
	}
	if string(p.Activity) == "null" {
		return ActivityUpdateCmd{userID: userID, Clear: true}, nil
	}
	var a struct {
		Name      *string `json:"name"`
		StartedAt *int64  `json:"started_at"`
	}
	if err := json.Unmarshal(p.Activity, &a); err != nil {
		return nil, fmt.Errorf("invalid activity_update activity: %w", err)
	}
	if a.Name == nil || a.StartedAt == nil {
		return nil, fmt.Errorf("invalid activity_update activity: name and started_at are required")
	}
	name, err := service.CleanActivityName(*a.Name)
	if err != nil {
		return nil, fmt.Errorf("invalid activity_update name: %w", err)
	}
	if name == "" {
		return ActivityUpdateCmd{userID: userID, Clear: true}, nil
	}
	return ActivityUpdateCmd{userID: userID, Name: name, StartedAt: *a.StartedAt}, nil
}

// handleActivityUpdateV2 decides what the frame changes against the activity the
// connection holds (info.Activity): a clear with nothing set and a set naming the
// game already shown are no-ops (no frame, no budget); a set over budget is
// RATE_LIMITED; a clear is never limited. The swap and broadcast happen in
// Hub.applyActivity, which knows the live status and whether the connection still
// owns its user's slot.
func handleActivityUpdateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	u := cmd.(ActivityUpdateCmd)

	if u.Clear {
		// Privacy: turning the setting off must hide the game at once, so a clear skips the
		// limiter. Only a clear that removes something broadcasts, and every set it undoes
		// was itself limited.
		if info.Activity == nil {
			return Result{}
		}
		return Result{SetActivity: &activityChange{}}
	}

	// An admin turned game activity off for the server. Refused before the limiter so
	// it costs no budget; the authoritative check is applyActivity's, under presenceMu.
	if d.GameActivityEnabled != nil && !d.GameActivityEnabled() {
		return Result{Error: ClientError{Code: ErrCodeGameActivityDisabled, Message: "game activity is turned off on this server"}}
	}

	now := time.Now()
	next := &gameActivity{Name: u.Name, StartedAt: clampActivityStart(u.StartedAt, now)}
	if sameGame(info.Activity, next) {
		return Result{}
	}
	// The name is the user's own text shown to every member, so a timeout refuses a set
	// (TIMED_OUT) like a custom status line.
	if d.ChannelSvc != nil {
		if err := d.ChannelSvc.CheckActivityAllowed(ctx, info.UserID); err != nil {
			return serviceErrorToResult(err)
		}
	}
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("activity", info.UserID), activityRateLimit, activityRateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many requests"}}
	}
	return Result{SetActivity: &activityChange{next: next}}
}

// clampActivityStart keeps a client-supplied start inside [now-24h, now].
func clampActivityStart(startedAt int64, now time.Time) int64 {
	return min(max(startedAt, now.Add(-activityMaxAge).UnixMilli()), now.UnixMilli())
}

// applyActivity swaps c's game for next and broadcasts the presence frame that
// shows it. It does nothing unless c still holds its user's slot (a same-account
// reconnect replaced it: the replacement carries its own activity, so a late frame
// from the replaced connection must not speak for the user) and has a stamped
// presence.
//
// Lock order is CustomStatusExpired's: presenceMu, then h.mu (read, in isRegistered),
// then the client's atomic presence pointer, then non-blocking enqueues. The
// compare-and-swap runs under presenceMu, so a racing status change either swaps
// first (this retries on top) or emits after this frame with the activity it read.
//
// A set is dropped while the server's game activity switch is off. The flag is read
// under presenceMu, after ApplyGameActivityPolicy stored it and before its sweep
// takes the same lock: a set arriving after the sweep is dropped, one arriving first
// is cleared by the sweep. A clear is always applied.
func (h *Hub) applyActivity(c *Client, next *gameActivity) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	if next != nil && !h.gameActivity.on.Load() {
		return
	}
	h.applyActivityLocked(c, next)
}

// applyActivityLocked is applyActivity's body; the caller holds presenceMu.
func (h *Hub) applyActivityLocked(c *Client, next *gameActivity) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if sameActivity(lp.activity, next) {
			return false
		}
		lp.activity = next
		return true
	})
}

// swapActivityLocked is the shared body of the game and listening appliers: it
// copies c's live presence, lets edit change the copy (false = nothing to change),
// swaps it in by compare-and-swap and broadcasts the presence frame carrying game
// and song together. It does nothing unless c is still registered (a same-session
// reconnect replaced it, and a late frame from the replaced connection must not
// speak for the user) and has a stamped presence. The caller holds presenceMu.
func (h *Hub) swapActivityLocked(c *Client, edit func(lp *livePresence) bool) {
	if !h.isRegistered(c) {
		return
	}
	var cur, updated *livePresence
	for {
		cur = c.presence.Load()
		if cur == nil {
			return
		}
		next := *cur
		if !edit(&next) {
			return
		}
		updated = &next
		if c.presence.CompareAndSwap(cur, updated) {
			break
		}
	}
	// The frame speaks for the user, not c: status and text are the user's merged
	// presence (the most recent setter's) and the activity is the merged one, so a game
	// stopped on one device does not blank another device's running game.
	conns := h.clientsOf(c.userID)
	h.broadcastMergedPresenceLocked(c.userID, conns, mergeLivePresence(conns))
}

// broadcastMergedPresenceLocked sends merged, the user's presence across conns, as
// the frame that speaks for the user. An unstamped presence sends nothing. The
// caller holds presenceMu.
func (h *Hub) broadcastMergedPresenceLocked(userID int64, conns []*Client, merged livePresence) {
	if merged.status == "" || len(conns) == 0 {
		return
	}
	text := visibleCustomStatus(merged.customStatus, merged.customStatusExpiresAt, time.Now())
	if db.BroadcastStatus(merged.status) != merged.status {
		// Invisible: others would only get another blank "offline" frame, and one per game
		// start or stop is itself a sign the user is online. Only the player hears it, on
		// every device; nothing public changed, so a queued connect entry stays.
		frame := buildPresenceMsg(userID, merged.status, text, merged.activity, merged.listening, merged.mobile)
		for _, own := range conns {
			own.sendPresenceMsg(frame)
		}
		return
	}
	// Like every user-chosen presence, this supersedes a queued connect entry.
	h.dropQueuedPresenceLocked(userID)
	for _, ev := range presenceEvents(userID, merged.status, text, merged.activity, merged.listening, merged.mobile) {
		h.enqueueExpiredPresence(conns[0], ev)
	}
}

// readyActivityPayload is one entry of ready.activities.
type readyActivityPayload struct {
	UserID    int64  `json:"user_id"`
	Name      string `json:"name"`
	StartedAt int64  `json:"started_at"`
}

// readyActivities lists the games viewerID may see: every connected user who reports
// one and is not offline to the viewer (db.StatusForViewer: an invisible user is
// offline to everyone but themselves), the viewer included, sorted by user id.
// Never nil. live is one livePresences snapshot shared with readyListening, so a
// ready never pairs a user's old game with their new song.
func readyActivities(live map[int64]livePresence, viewerID int64) []readyActivityPayload {
	out := []readyActivityPayload{}
	for uid, lp := range live {
		if lp.activity == nil || lp.status == "" {
			continue
		}
		if db.StatusForViewer(lp.status, uid, viewerID) == db.StatusOffline {
			continue
		}
		out = append(out, readyActivityPayload{UserID: uid, Name: lp.activity.Name, StartedAt: lp.activity.StartedAt})
	}
	slices.SortFunc(out, func(a, b readyActivityPayload) int { return cmp.Compare(a.UserID, b.UserID) })
	return out
}

// command.go is at its size ceiling, so the constructor registers itself.
func init() { commandConstructors[MsgTypeActivityUpdate] = parseActivityUpdate }

// readyListening lists the songs viewerID may see, by readyActivities' rules, sorted
// by user id; never nil.
func readyListening(live map[int64]livePresence, viewerID int64) []readyListeningPayload {
	out := []readyListeningPayload{}
	for uid, lp := range live {
		if lp.listening == nil || lp.status == "" {
			continue
		}
		if db.StatusForViewer(lp.status, uid, viewerID) == db.StatusOffline {
			continue
		}
		out = append(out, readyListeningPayload{UserID: uid, listeningActivity: *lp.listening})
	}
	slices.SortFunc(out, func(a, b readyListeningPayload) int { return cmp.Compare(a.UserID, b.UserID) })
	return out
}

// clearActivityAndListeningLocked clears c's game and song in one swap so the server
// switch going off sends one presence frame per user. The caller holds presenceMu.
func (h *Hub) clearActivityAndListeningLocked(c *Client) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if lp.activity == nil && lp.listening == nil {
			return false
		}
		lp.activity, lp.listening = nil, nil
		return true
	})
}

// bareActivityFrame is the presence frame without game and song, built only when
// there is something to leave out (nil otherwise).
func bareActivityFrame(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity, mobile bool) []byte {
	if activity == nil && listening == nil {
		return nil
	}
	return buildPresenceMsg(userID, status, customStatus, nil, nil, mobile)
}
