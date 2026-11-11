package ws

// The song a member is listening to, reported with listening_update and shown on presence,
// presence_batch and ready.listening. Like the game (game_activity.go) it is memory only, cleared
// by disconnect or restart; the game_activity_enabled switch covers both.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

const (
	// listeningRateLimit and listeningRateWindow bound how often a connection may set (not clear)
	// its song: 1 per 10 s, on its own budget so a song change never eats the game's or the auto-
	// idle presence_update's.
	listeningRateLimit   = 1
	listeningRateWindow  = 10 * time.Second
	listeningMaxDuration = 24 * time.Hour
)

// listeningActivity is a connection's reported song, immutable once published (a change swaps in a
// new value); the json tags are the wire shape.
type listeningActivity struct {
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Player     string `json:"player"`
	StartedAt  int64  `json:"started_at"`  // unix milliseconds (now minus the position)
	DurationMS int64  `json:"duration_ms"` // 0 = unknown
}

func sameListening(a, b *listeningActivity) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// sameSong reports whether next names the song cur shows (title, artist, player). A repeat keeps
// cur's start and duration: a seek moves started_at and clients re-send after every reconnect, so
// comparing them would rebroadcast on every poll.
func sameSong(cur, next *listeningActivity) bool {
	return cur != nil && next != nil &&
		cur.Title == next.Title && cur.Artist == next.Artist && cur.Player == next.Player
}

type listeningChange struct {
	next *listeningActivity
}

// ListeningUpdateCmd sets or clears listening activity. Clear is set for "listening": null and an
// empty trimmed title; otherwise the text is cleaned, StartedAt is the client's unix ms (clamped by
// the handler) and DurationMS is capped.
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

// parseListeningUpdate: a missing field, wrong JSON type, non-integer number, text failing the
// custom status rules, empty player or negative duration is BAD_REQUEST.
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

// handleListeningUpdateV2 decides against the held song (info.Listening): a clear with nothing set,
// or a set naming the shown song, is a no-op (no frame, no budget); a set while the server switch
// is off is refused before the limiter; a set over budget is RATE_LIMITED; a clear is never
// limited. Hub.applyListening does the swap and broadcast.
func handleListeningUpdateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	u := cmd.(ListeningUpdateCmd)

	if u.Clear {
		// Privacy: pausing or turning the setting off must hide the song at once, so a clear skips
		// the limiter.
		if info.Listening == nil {
			return Result{}
		}
		return Result{SetListening: &listeningChange{}}
	}

	// The game's switch: refused before the limiter so it costs no budget; applyListening's check
	// under presenceFeed.mu is authoritative.
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
	// Title and artist are shown to every member, so a timeout refuses a set (TIMED_OUT) like a
	// game name.
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

// applyListening swaps c's song for next and broadcasts the presence frame, under applyActivity's
// ownership, lock-order and switch rules.
func (h *Hub) applyListening(c *Client, next *listeningActivity) {
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	if next != nil && !h.settings.gameActivity.on.Load() {
		return
	}
	h.applyListeningLocked(c, next)
}

// applyListeningLocked is applyListening's body; the caller holds presenceFeed.mu.
func (h *Hub) applyListeningLocked(c *Client, next *listeningActivity) {
	h.swapActivityLocked(c, func(lp *livePresence) bool {
		if sameListening(lp.listening, next) {
			return false
		}
		lp.listening = next
		return true
	})
}

type readyListeningPayload struct {
	UserID int64 `json:"user_id"`
	listeningActivity
}

func init() { commandConstructors[MsgTypeListeningUpdate] = parseListeningUpdate }
