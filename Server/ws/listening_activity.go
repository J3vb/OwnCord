package ws

// listening_activity.go — the song a member is listening to,
// reported by the client with listening_update and shown on presence,
// presence_batch and ready.listening. Like the game (game_activity.go) it is
// memory only (livePresence.listening): no table, and a disconnect or restart
// clears it. The per-server switch game_activity_enabled covers both.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

const (
	// listeningRateLimit and listeningRateWindow bound how often a connection
	// may set (not clear) its song: 1 per 10 s, on its own budget so a song
	// change never eats the game's or the auto-idle presence_update's.
	listeningRateLimit  = 1
	listeningRateWindow = 10 * time.Second
	// listeningMaxDuration caps duration_ms (0 means unknown).
	listeningMaxDuration = 24 * time.Hour
)

// listeningActivity is a connection's reported song. Immutable once
// published: a change swaps in a new value. The json tags are the wire shape,
// used by the presence payloads and ready.listening alike.
type listeningActivity struct {
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Player     string `json:"player"`
	StartedAt  int64  `json:"started_at"`  // unix milliseconds (now minus the position)
	DurationMS int64  `json:"duration_ms"` // 0 = unknown
}

// sameListening reports whether a and b are the same value. It is the
// applier's guard against re-broadcasting what it already holds.
func sameListening(a, b *listeningActivity) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// sameSong reports whether next names the song cur already shows (title,
// artist and player). A repeat keeps cur's start and duration: a seek moves
// started_at, and the client re-sends after every reconnect, so comparing
// them would rebroadcast on every poll.
func sameSong(cur, next *listeningActivity) bool {
	return cur != nil && next != nil &&
		cur.Title == next.Title && cur.Artist == next.Artist && cur.Player == next.Player
}

// listeningChange is Result.SetListening: the song to swap in, nil to clear.
type listeningChange struct {
	next *listeningActivity
}

// ListeningUpdateCmd represents a listening_update message. Clear is set for
// "listening": null and for a title that is empty after trimming; otherwise
// the text fields are cleaned, StartedAt is the client's unix milliseconds,
// not yet clamped (the handler does that against its clock), and DurationMS is
// already capped.
type ListeningUpdateCmd struct {
	userID     int64
	Clear      bool
	Title      string
	Artist     string
	Player     string
	StartedAt  int64
	DurationMS int64
}

func (c ListeningUpdateCmd) Type() string  { return MsgTypeListeningUpdate }
func (c ListeningUpdateCmd) UserID() int64 { return c.userID }

// parseListeningUpdate builds a ListeningUpdateCmd from a listening_update
// payload. A missing field, a wrong JSON type, a non-integer number, a text
// that fails the custom status text rules, an empty player or a negative
// duration is an error (BAD_REQUEST).
func parseListeningUpdate(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		Listening json.RawMessage `json:"listening"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid listening_update payload: %w", err)
	}
	if len(p.Listening) == 0 {
		return nil, fmt.Errorf("invalid listening_update payload: listening is required")
	}
	if string(p.Listening) == "null" {
		return ListeningUpdateCmd{userID: userID, Clear: true}, nil
	}
	var l struct {
		Title      *string `json:"title"`
		Artist     *string `json:"artist"`
		Player     *string `json:"player"`
		StartedAt  *int64  `json:"started_at"`
		DurationMS *int64  `json:"duration_ms"`
	}
	if err := json.Unmarshal(p.Listening, &l); err != nil {
		return nil, fmt.Errorf("invalid listening_update listening: %w", err)
	}
	if l.Title == nil || l.Artist == nil || l.Player == nil || l.StartedAt == nil || l.DurationMS == nil {
		return nil, fmt.Errorf("invalid listening_update listening: title, artist, player, started_at and duration_ms are required")
	}
	title, err := service.CleanListeningText(*l.Title, service.MaxListeningTitleLen, "listening title")
	if err != nil {
		return nil, fmt.Errorf("invalid listening_update title: %w", err)
	}
	if title == "" {
		return ListeningUpdateCmd{userID: userID, Clear: true}, nil
	}
	artist, err := service.CleanListeningText(*l.Artist, service.MaxListeningArtistLen, "listening artist")
	if err != nil {
		return nil, fmt.Errorf("invalid listening_update artist: %w", err)
	}
	player, err := service.CleanListeningText(*l.Player, service.MaxListeningPlayerLen, "listening player")
	if err != nil {
		return nil, fmt.Errorf("invalid listening_update player: %w", err)
	}
	if player == "" {
		return nil, fmt.Errorf("invalid listening_update player: player is required")
	}
	if *l.DurationMS < 0 {
		return nil, fmt.Errorf("invalid listening_update duration_ms: must not be negative")
	}
	return ListeningUpdateCmd{
		userID:     userID,
		Title:      title,
		Artist:     artist,
		Player:     player,
		StartedAt:  *l.StartedAt,
		DurationMS: min(*l.DurationMS, listeningMaxDuration.Milliseconds()),
	}, nil
}

// handleListeningUpdateV2 is the V2 handler for listening_update messages. It
// decides what the frame changes, against the song the connection holds
// (info.Listening): a clear with nothing set and a set that names the song
// already shown are no-ops (no frame, no budget); a set while the server
// switch is off is refused before the limiter; a set over budget is
// RATE_LIMITED; a clear is never limited. The swap and the broadcast happen in
// the applier (Hub.applyListening), which knows the live status and whether
// the connection still owns its user's slot.
func handleListeningUpdateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	u := cmd.(ListeningUpdateCmd)

	if u.Clear {
		// Privacy: pausing or turning the setting off must hide the song at
		// once, so a clear skips the limiter.
		if info.Listening == nil {
			return Result{}
		}
		return Result{SetListening: &listeningChange{}}
	}

	// The same switch as the game's: refused before the limiter so the refusal
	// costs no budget; the authoritative check is applyListening's, under
	// presenceMu.
	if d.GameActivityEnabled != nil && !d.GameActivityEnabled() {
		return Result{Error: ClientError{Code: ErrCodeGameActivityDisabled, Message: "member activity is turned off on this server"}}
	}

	next := &listeningActivity{
		Title:      u.Title,
		Artist:     u.Artist,
		Player:     u.Player,
		StartedAt:  clampActivityStart(u.StartedAt, time.Now()),
		DurationMS: u.DurationMS,
	}
	if sameSong(info.Listening, next) {
		return Result{}
	}
	// Title and artist are the user's own text shown to every member, so a
	// timeout refuses a set (TIMED_OUT) the way it refuses a game name.
	if d.ChannelSvc != nil {
		if err := d.ChannelSvc.CheckActivityAllowed(ctx, info.UserID); err != nil {
			return serviceErrorToResult(err)
		}
	}
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("listening", info.UserID), listeningRateLimit, listeningRateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many requests"}}
	}
	return Result{SetListening: &listeningChange{next: next}}
}

// applyListening swaps c's song for next and broadcasts the presence frame
// that shows it. The ownership, lock-order and switch rules are
// applyActivity's: it does nothing unless c still holds its user's slot, a set
// is dropped while the server switch is off (read under presenceMu), and a
// clear is always applied.
func (h *Hub) applyListening(c *Client, next *listeningActivity) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	if next != nil && !h.gameActivity.on.Load() {
		return
	}
	h.applyListeningLocked(c, next)
}

// applyListeningLocked is applyListening's body. The caller holds presenceMu.
func (h *Hub) applyListeningLocked(c *Client, next *listeningActivity) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if sameListening(lp.listening, next) {
			return false
		}
		lp.listening = next
		return true
	})
}

// readyListeningPayload is one entry of ready.listening.
type readyListeningPayload struct {
	UserID int64 `json:"user_id"`
	listeningActivity
}

// command.go sits at its size ceiling, so the constructor registers itself.
func init() { commandConstructors[MsgTypeListeningUpdate] = parseListeningUpdate }
