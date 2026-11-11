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
	// StampFlushInterval bounds how long a connect or disconnect status stamp waits. Short,
	// because direct readers of users.status (REST, admin) lag by it; @here and DM statuses
	// read the hub's live status.
	StampFlushInterval = 2 * time.Second
	// TouchFlushInterval bounds how long a session touch waits. Idle expiry slides by 30
	// days, so a minute of lag is invisible and 2,000 idle sockets cost one write a minute.
	TouchFlushInterval = 60 * time.Second
)

type connWritesStore interface {
	StampConnections(ctx context.Context, connected, disconnected []int64) error
	TouchAPIToken(ctx context.Context, tokenHash string) error
	DeleteSession(ctx context.Context, tokenHash string) error
	TouchSessions(ctx context.Context, tokenHashes []string) error
}

// ConnWrites batches the writes a live connection makes about itself (session touch,
// connect/disconnect status stamps) into one writer transaction per interval instead of
// queueing behind message sends. It holds nothing a security decision reads: revocation
// deletes the session row on a separate read path, and a touch never revives a lapsed row
// (TouchSessions' WHERE), judged at flush: a use in the last TouchFlushInterval before
// idle expiry can let the session lapse first, an accepted edge. A crash loses at most one
// interval; boot-time ResetAllUserStatuses clears a lost disconnect stamp's "online".
type ConnWrites struct {
	st      connWritesStore
	mu      syncutil.Mutex
	touches map[string]struct{} // session token hashes touched since the last flush
	stamps  map[int64]bool      // user ID -> connected; the latest stamp wins
	// apiTouches are API-token hashes used since the last flush; discards are expired-session
	// hashes the REST middleware wants deleted. Queued from request goroutines so no request
	// writes; a hash queued a thousand times is written once per flush.
	apiTouches map[string]struct{}
	discards   map[string]struct{}
}

// BatchConnWrites installs one ConnWrites over the store into Users, Sessions and
// Channels and returns it for the owner to Run and Flush. Without it each writes at once.
func (s *Services) BatchConnWrites() *ConnWrites {
	w := NewConnWrites(s.Users.st)
	s.Users.SetConnWrites(w)
	s.Sessions.SetConnWrites(w)
	s.Channels.SetConnWrites(w)
	return w
}

// NewConnWrites returns an empty batch writing through st; Run flushes it.
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
// committed a newer status (its write refreshed last_seen); a pending disconnect stays.
func (w *ConnWrites) dropConnectStamp(userID int64) {
	w.mu.Lock()
	if w.stamps[userID] {
		delete(w.stamps, userID)
	}
	w.mu.Unlock()
}

// Run flushes stamps every StampFlushInterval and touches every TouchFlushInterval until
// ctx ends. After the hub stops the owner calls Flush once more, which first queues a
// disconnect stamp for every user the hub held at stop.
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

// Flush writes everything pending now; a failed write keeps its entries. Not concurrent
// with Run: two flushes in flight could land one user's stamps out of order.
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

func (w *ConnWrites) flushAPITouches(ctx context.Context) error {
	return w.flushHashes(ctx, &w.apiTouches, w.st.TouchAPIToken, "flushing api token touches")
}

func (w *ConnWrites) flushDiscards(ctx context.Context) error {
	return w.flushHashes(ctx, &w.discards, w.st.DeleteSession, "flushing expired session discards")
}

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
