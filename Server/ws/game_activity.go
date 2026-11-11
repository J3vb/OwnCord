package ws

// The game a member is playing, reported by activity_update and shown on
// presence, presence_batch and ready.activities. Memory only
// (Client.presence.activity): no table, cleared by disconnect or restart.

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
	// activityRateLimit and activityRateWindow bound how often a connection may
	// set (not clear) its activity: 1 per 10 s, on its own budget so auto-idle
	// presence_update is never starved.
	activityRateLimit  = 1
	activityRateWindow = 10 * time.Second
	activityMaxAge     = 24 * time.Hour
)

type gameActivity struct {
	Name      string `json:"name"`
	StartedAt int64  `json:"started_at"` // unix milliseconds
}

// sameActivity is the applier's exact guard against re-broadcasting the value it
// holds; the handler's no-op check compares names only (sameGame).
func sameActivity(a, b *gameActivity) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// sameGame reports whether next names the game cur already shows. A repeat keeps
// cur's start: clients re-send after every reconnect and an old start clamps to a
// moving bound, so comparing starts would rebroadcast on every poll.
func sameGame(cur, next *gameActivity) bool {
	return cur != nil && next != nil && cur.Name == next.Name
}

type activityChange struct {
	next *gameActivity
}

// ActivityUpdateCmd sets or clears game activity. Clear is set for "activity": null or an empty name;
// otherwise Name is the cleaned name and StartedAt the client's unix ms, not yet
// clamped.
type ActivityUpdateCmd struct {
	userID    int64
	Clear     bool
	Name      string
	StartedAt int64
}

func (c ActivityUpdateCmd) Type() string  { return MsgTypeActivityUpdate }
func (c ActivityUpdateCmd) UserID() int64 { return c.userID }

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

// handleActivityUpdateV2 decides against the held activity (info.Activity): a
// clear with nothing set, or a set naming the shown game, is a no-op (no frame,
// no budget); a set over budget is RATE_LIMITED; a clear is never limited.
// Hub.applyActivity does the swap and broadcast.
func handleActivityUpdateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	u := cmd.(ActivityUpdateCmd)

	if u.Clear {
		// Privacy: turning the setting off must hide the game at once, so a clear
		// skips the limiter.
		if info.Activity == nil {
			return Result{}
		}
		return Result{SetActivity: &activityChange{}}
	}

	// An admin turned game activity off. Refused before the limiter so it costs
	// no budget; applyActivity's check under presenceFeed.mu is authoritative.
	if d.GameActivityEnabled != nil && !d.GameActivityEnabled() {
		return Result{Error: ClientError{Code: ErrCodeGameActivityDisabled, Message: "game activity is turned off on this server"}}
	}

	now := time.Now()
	next := &gameActivity{Name: u.Name, StartedAt: clampActivityStart(u.StartedAt, now)}
	if sameGame(info.Activity, next) {
		return Result{}
	}
	// The name is shown to every member, so a timeout refuses a set (TIMED_OUT)
	// like a custom status line.
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

func clampActivityStart(startedAt int64, now time.Time) int64 {
	return min(max(startedAt, now.Add(-activityMaxAge).UnixMilli()), now.UnixMilli())
}

// applyActivity swaps c's game for next and broadcasts the presence frame. It
// does nothing unless c still holds its user's slot (a replaced connection must
// not speak for the user) and has a stamped presence.
// Lock order is CustomStatusExpired's: presenceFeed.mu, then h.mu (read, in
// isRegistered), then the client's atomic presence pointer, then non-blocking
// enqueues. The compare-and-swap runs under presenceFeed.mu, so a racing status
// change swaps first (this retries) or emits after this frame.
// A set is dropped while the server's game switch is off. The flag is read under
// presenceFeed.mu, after ApplyGameActivityPolicy stored it and before its sweep
// takes the same lock, so a set after the sweep is dropped and one before it is
// swept. A clear always applies.
func (h *Hub) applyActivity(c *Client, next *gameActivity) {
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	if next != nil && !h.settings.gameActivity.on.Load() {
		return
	}
	h.applyActivityLocked(c, next)
}

// applyActivityLocked is applyActivity's body; the caller holds presenceFeed.mu.
func (h *Hub) applyActivityLocked(c *Client, next *gameActivity) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if sameActivity(lp.activity, next) {
			return false
		}
		lp.activity = next
		return true
	})
}

// swapActivityLocked is the shared body of the game and listening appliers: copy
// c's live presence, let edit change it (false = nothing), compare-and-swap it in
// and broadcast the frame carrying game and song. No-op unless c is still
// registered and has a stamped presence. Caller holds presenceFeed.mu.
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
	// The frame speaks for the user: status, text and activity are the merged
	// presence, so stopping a game on one device does not blank another's.
	conns := h.clientsOf(c.userID)
	h.broadcastMergedPresenceLocked(c.userID, conns, mergeLivePresence(conns))
}

// broadcastMergedPresenceLocked sends the merged presence; the caller holds presenceFeed.mu.
func (h *Hub) broadcastMergedPresenceLocked(userID int64, conns []*Client, merged livePresence) {
	if merged.status == "" || len(conns) == 0 {
		return
	}
	text := visibleCustomStatus(merged.customStatus, merged.customStatusExpiresAt, time.Now())
	if db.BroadcastStatus(merged.status) != merged.status {
		// Invisible: another blank "offline" frame per game start or stop would
		// itself show the user is online. Only the player hears it, on every
		// device; nothing public changed, so a queued connect entry stays.
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

type readyActivityPayload struct {
	UserID    int64  `json:"user_id"`
	Name      string `json:"name"`
	StartedAt int64  `json:"started_at"`
}

// readyActivities lists the games viewerID may see: connected users reporting one
// and not offline to the viewer (an invisible user is offline to everyone but
// themselves), sorted by user id, never nil. live is shared with readyListening
// so a ready never pairs an old game with a new song.
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

func init() { commandConstructors[MsgTypeActivityUpdate] = parseActivityUpdate }

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

// clearActivityAndListeningLocked clears game and song in one swap so the switch
// going off sends one frame per user. Caller holds presenceFeed.mu.
func (h *Hub) clearActivityAndListeningLocked(c *Client) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if lp.activity == nil && lp.listening == nil {
			return false
		}
		lp.activity, lp.listening = nil, nil
		return true
	})
}

func bareActivityFrame(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity, mobile bool) []byte {
	if activity == nil && listening == nil {
		return nil
	}
	return buildPresenceMsg(userID, status, customStatus, nil, nil, mobile)
}
