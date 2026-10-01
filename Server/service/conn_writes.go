package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	// StampFlushInterval bounds how long a connect or disconnect status stamp
	// waits for the writer. Short, because a few readers (@here, DM status)
	// read users.status itself; a 2,000-client reconnect herd over 15 s still
	// collapses into a handful of statements instead of 2,000.
	StampFlushInterval = 2 * time.Second
	// TouchFlushInterval bounds how long a session touch waits. The idle
	// expiry slides by 30 days, so a minute of lag on last_used and
	// expires_at is invisible, and 2,000 idle sockets cost one write a minute
	// instead of about 33 a second.
	TouchFlushInterval = 60 * time.Second
)

// ConnWrites batches the writes a live connection makes about itself — the
// session touch on connect and ping, and the connect and disconnect status
// stamps — so they share one writer transaction per interval instead of
// queueing one each behind message sends (P5-S07, B6).
//
// It holds nothing a security decision reads: revocation deletes the session
// row and is checked on a separate read path, and a touch never revives a
// lapsed row (TouchSessions' WHERE). That rule is judged at the flush, so a
// use in the last TouchFlushInterval before a session's idle expiry can let
// it lapse before the queued touch lands, signing the user out; the edge is
// accepted rather than reviving a lapsed row. A crash loses at most one interval of
// pending writes; the boot-time ResetAllUserStatuses clears the "online" a
// lost disconnect stamp leaves behind.
type ConnWrites struct {
	st      Store
	mu      syncutil.Mutex
	touches map[string]struct{} // session token hashes touched since the last flush
	stamps  map[int64]bool      // user ID -> connected; the latest stamp wins
}

// BatchConnWrites installs one ConnWrites over the services' store into Users,
// Sessions and Channels and returns it for the owner to Run and Flush. Without it both
// services write each stamp and touch at once.
func (s *Services) BatchConnWrites() *ConnWrites {
	w := NewConnWrites(s.Users.st)
	s.Users.SetConnWrites(w)
	s.Sessions.SetConnWrites(w)
	s.Channels.SetConnWrites(w)
	return w
}

// NewConnWrites returns an empty batch writing through st. Run flushes it;
// install it with SessionService.SetConnWrites and UserService.SetConnWrites.
func NewConnWrites(st Store) *ConnWrites {
	return &ConnWrites{st: st, touches: map[string]struct{}{}, stamps: map[int64]bool{}}
}

func (w *ConnWrites) queueTouch(tokenHash string) {
	w.mu.Lock()
	w.touches[tokenHash] = struct{}{}
	w.mu.Unlock()
}

func (w *ConnWrites) queueStamp(userID int64, connected bool) {
	w.mu.Lock()
	w.stamps[userID] = connected
	w.mu.Unlock()
}

// dropConnectStamp discards userID's pending connect stamp, once a
// presence_update has committed a newer status for them. Its own write
// refreshed last_seen, so nothing is lost; a pending disconnect stays.
func (w *ConnWrites) dropConnectStamp(userID int64) {
	w.mu.Lock()
	if w.stamps[userID] {
		delete(w.stamps, userID)
	}
	w.mu.Unlock()
}

// Run flushes stamps every StampFlushInterval and touches every
// TouchFlushInterval until ctx ends. The owner calls Flush once more after
// Run returns and the hub has stopped, which writes the last touches and the
// stamps queued by then; a disconnect stamp queued later is lost like a
// crash, and the boot-time ResetAllUserStatuses clears the "online" it
// leaves.
func (w *ConnWrites) Run(ctx context.Context) {
	stamps := time.NewTicker(StampFlushInterval)
	defer stamps.Stop()
	touches := time.NewTicker(TouchFlushInterval)
	defer touches.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stamps.C:
			if err := w.flushStamps(ctx); err != nil {
				slog.Warn("connection stamps flush failed, retrying next interval", "err", err)
			}
		case <-touches.C:
			if err := w.flushTouches(ctx); err != nil {
				slog.Warn("session touches flush failed, retrying next interval", "err", err)
			}
		}
	}
}

// Flush writes everything pending now. A failed write keeps its entries for
// the next flush. Not for use concurrently with Run: two flushes in flight
// could land one user's stamps out of order.
func (w *ConnWrites) Flush(ctx context.Context) error {
	return errors.Join(w.flushStamps(ctx), w.flushTouches(ctx))
}

func (w *ConnWrites) flushStamps(ctx context.Context) error {
	w.mu.Lock()
	pending := w.stamps
	if len(pending) == 0 {
		w.mu.Unlock()
		return nil
	}
	w.stamps = make(map[int64]bool, len(pending))
	w.mu.Unlock()

	var connected, disconnected []int64
	for id, up := range pending {
		if up {
			connected = append(connected, id)
		} else {
			disconnected = append(disconnected, id)
		}
	}
	if err := w.st.StampConnections(ctx, connected, disconnected); err != nil {
		w.mu.Lock()
		for id, up := range pending {
			if _, newer := w.stamps[id]; !newer {
				w.stamps[id] = up
			}
		}
		w.mu.Unlock()
		return fmt.Errorf("%w: flushing connection stamps: %w", ErrInternal, err)
	}
	return nil
}

func (w *ConnWrites) flushTouches(ctx context.Context) error {
	w.mu.Lock()
	pending := w.touches
	if len(pending) == 0 {
		w.mu.Unlock()
		return nil
	}
	w.touches = make(map[string]struct{}, len(pending))
	w.mu.Unlock()

	tokens := make([]string, 0, len(pending))
	for tok := range pending {
		tokens = append(tokens, tok)
	}
	if err := w.st.TouchSessions(ctx, tokens); err != nil {
		w.mu.Lock()
		for tok := range pending {
			w.touches[tok] = struct{}{}
		}
		w.mu.Unlock()
		return fmt.Errorf("%w: flushing session touches: %w", ErrInternal, err)
	}
	return nil
}
