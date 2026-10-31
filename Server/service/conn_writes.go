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
	// StampFlushInterval bounds how long a connect or disconnect status stamp waits
	// for the writer. Short, because direct readers of users.status (REST and admin
	// reads) lag by that long; @here and DM statuses read the hub's live status. A
	// 2,000-client reconnect herd over 15 s still collapses into a handful of
	// statements.
	StampFlushInterval = 2 * time.Second
	// TouchFlushInterval bounds how long a session touch waits. The idle expiry slides
	// by 30 days, so a minute of lag is invisible, and 2,000 idle sockets cost one
	// write a minute instead of about 33 a second.
	TouchFlushInterval = 60 * time.Second
)

// connWritesStore is what ConnWrites reads and writes. *db.DB satisfies it.
type connWritesStore interface {
	StampConnections(ctx context.Context, connected, disconnected []int64) error
	TouchAPIToken(ctx context.Context, tokenHash string) error
	DeleteSession(ctx context.Context, tokenHash string) error
	TouchSessions(ctx context.Context, tokenHashes []string) error
}

// ConnWrites batches the writes a live connection makes about itself (the session
// touch on connect and ping, and the connect and disconnect status stamps) so they
// share one writer transaction per interval instead of queueing behind message
// sends.
// It holds nothing a security decision reads: revocation deletes the session row
// and is checked on a separate read path, and a touch never revives a lapsed row
// (TouchSessions' WHERE). That rule is judged at the flush, so a use in the last
// TouchFlushInterval before idle expiry can let the session lapse before the
// queued touch lands, signing the user out; the edge is accepted rather than
// reviving a lapsed row. A crash loses at most one interval of pending writes; the
// boot-time ResetAllUserStatuses clears the "online" a lost disconnect stamp
// leaves behind.
type ConnWrites struct {
	st      connWritesStore
	mu      syncutil.Mutex
	touches map[string]struct{} // session token hashes touched since the last flush
	stamps  map[int64]bool      // user ID -> connected; the latest stamp wins
	// apiTouches are API-token hashes used since the last flush, and discards are
	// expired-session hashes the REST middleware wants deleted. Both are queued from
	// request goroutines so no request issues a write; a hash queued a thousand times
	// is written once per flush.
	apiTouches map[string]struct{}
	discards   map[string]struct{}
}

// BatchConnWrites installs one ConnWrites over the services' store into Users,
// Sessions and Channels and returns it for the owner to Run and Flush. Without it
// each service writes every stamp and touch at once.
func (s *Services) BatchConnWrites() *ConnWrites {
	w := NewConnWrites(s.Users.st)
	s.Users.SetConnWrites(w)
	s.Sessions.SetConnWrites(w)
	s.Channels.SetConnWrites(w)
	return w
}

// NewConnWrites returns an empty batch writing through st. Run flushes it;
// install it with SessionService.SetConnWrites and UserService.SetConnWrites.
func NewConnWrites(st connWritesStore) *ConnWrites {
	return &ConnWrites{
		st: st, touches: map[string]struct{}{}, stamps: map[int64]bool{},
		apiTouches: map[string]struct{}{}, discards: map[string]struct{}{},
	}
}

func (w *ConnWrites) queueTouch(tokenHash string) {
	w.mu.Lock()
	w.touches[tokenHash] = struct{}{}
	w.mu.Unlock()
}

func (w *ConnWrites) queueAPITouch(tokenHash string) {
	w.mu.Lock()
	w.apiTouches[tokenHash] = struct{}{}
	w.mu.Unlock()
}

func (w *ConnWrites) queueDiscard(tokenHash string) {
	w.mu.Lock()
	w.discards[tokenHash] = struct{}{}
	w.mu.Unlock()
}

func (w *ConnWrites) queueStamp(userID int64, connected bool) {
	w.mu.Lock()
	w.stamps[userID] = connected
	w.mu.Unlock()
}

// dropConnectStamp discards userID's pending connect stamp once a presence_update
// has committed a newer status; its own write refreshed last_seen, so nothing is
// lost, and a pending disconnect stays.
func (w *ConnWrites) dropConnectStamp(userID int64) {
	w.mu.Lock()
	if w.stamps[userID] {
		delete(w.stamps, userID)
	}
	w.mu.Unlock()
}

// Run flushes stamps every StampFlushInterval and touches every TouchFlushInterval
// until ctx ends. After Run returns and the hub has stopped, the owner calls Flush
// once more; first it queues a disconnect stamp for every user the hub held when
// its stop began, whose own readPump stamp would come too late.
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
			if err := w.flushDiscards(ctx); err != nil {
				slog.Warn("expired session discards flush failed, retrying next interval", "err", err)
			}
		case <-touches.C:
			if err := w.flushTouches(ctx); err != nil {
				slog.Warn("session touches flush failed, retrying next interval", "err", err)
			}
			if err := w.flushAPITouches(ctx); err != nil {
				slog.Warn("api token touches flush failed, retrying next interval", "err", err)
			}
		}
	}
}

// Flush writes everything pending now. A failed write keeps its entries for the
// next flush. Not for use concurrently with Run: two flushes in flight could land
// one user's stamps out of order.
func (w *ConnWrites) Flush(ctx context.Context) error {
	return errors.Join(w.flushStamps(ctx), w.flushDiscards(ctx), w.flushTouches(ctx), w.flushAPITouches(ctx))
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

// flushAPITouches writes last_used for each distinct queued API-token hash, one
// store call per hash (no batched query; the minute throttle keeps the count at
// one per active token). A hash whose write fails, or that the loop did not reach
// because ctx ended, is queued again.
func (w *ConnWrites) flushAPITouches(ctx context.Context) error {
	return w.flushHashes(ctx, &w.apiTouches, w.st.TouchAPIToken, "flushing api token touches")
}

// flushDiscards deletes each distinct expired-session hash queued since the
// last flush, with the same re-queue rule as flushAPITouches. Deleting is
// idempotent, so a hash the maintenance sweep already removed is not an error.
func (w *ConnWrites) flushDiscards(ctx context.Context) error {
	return w.flushHashes(ctx, &w.discards, w.st.DeleteSession, "flushing expired session discards")
}

// flushHashes swaps *set for an empty map, applies write to every hash in the
// old one and re-queues the hashes that did not land.
func (w *ConnWrites) flushHashes(ctx context.Context, set *map[string]struct{}, write func(context.Context, string) error, what string) error {
	w.mu.Lock()
	pending := *set
	if len(pending) == 0 {
		w.mu.Unlock()
		return nil
	}
	*set = make(map[string]struct{}, len(pending))
	w.mu.Unlock()

	var failed []string
	var errs []error
	for hash := range pending {
		if ctx.Err() != nil {
			failed = append(failed, hash)
			continue
		}
		if err := write(ctx, hash); err != nil {
			failed = append(failed, hash)
			errs = append(errs, err)
		}
	}
	if len(failed) == 0 {
		return nil
	}
	w.mu.Lock()
	for _, hash := range failed {
		(*set)[hash] = struct{}{}
	}
	w.mu.Unlock()
	if len(errs) == 0 {
		errs = append(errs, ctx.Err())
	}
	return fmt.Errorf("%w: %s: %w", ErrInternal, what, errors.Join(errs...))
}
