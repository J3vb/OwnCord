package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/J3vb/OwnCord/Server/db"
)

// NicknameStore is the one write the moderator nickname route needs.
type NicknameStore interface {
	// SetDisplayNameAsModerator writes a member's nickname for a moderator and
	// returns the value it replaced. It re-reads the actor's MANAGE_NICKNAMES
	// (or ADMINISTRATOR) bit across every held role and the actor-outranks-
	// target rank live in its write transaction, and returns db.ErrOutranked
	// when either fails.
	SetDisplayNameAsModerator(ctx context.Context, actorID, targetID int64, name *string) (old *string, err error)
}

// setDisplayNameAsModerator is the moderator nickname write. It takes
// the target's profile lock, the one UpdateProfile's read-merge-write holds, so
// the two serialize and the later writer wins whole: neither can merge against
// a row the other is about to replace. The write itself re-checks the actor's
// authority in its transaction (db.SetDisplayNameAsModerator). The returned
// user is the committed row, never the request. Lock order: profileLocks[target]
// then the single writer connection, as in UpdateProfile; no hub lock is held,
// the caller broadcasts after this returns.
func (s *UserService) setDisplayNameAsModerator(ctx context.Context, actorID, targetID int64, name *string) (*db.User, error) {
	unlock := s.profileLocks.lock(targetID)
	defer unlock()

	current, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || current == nil || current.IsSystemAccount() {
		return nil, fmt.Errorf("%w: user not found", db.ErrNotFound)
	}
	ns, ok := s.st.(NicknameStore)
	if !ok {
		// A Store double without the slice; the route then reports an internal error.
		return nil, errors.New("moderator nickname write unavailable")
	}
	old, err := ns.SetDisplayNameAsModerator(ctx, actorID, targetID, name)
	if err != nil {
		return nil, fmt.Errorf("set display name: %w", err)
	}

	// The write has committed: the re-read and the audit row must survive a
	// request canceled after it, and a failed re-read must not be reported as
	// a failed write, so fall back to the pre-write row with the
	// one column this call changed.
	user, err := s.st.GetUserByID(context.WithoutCancel(ctx), targetID)
	if err != nil || user == nil {
		slog.Error("moderator nickname re-read failed; returning locally merged row",
			"target_id", targetID, "error", err)
		merged := *current
		merged.DisplayName = name
		user = &merged
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "nickname_change", "user", targetID,
		fmt.Sprintf("nickname %s -> %s", quoteNickname(old), quoteNickname(name)))
	slog.Info("nickname changed by moderator", "actor_id", actorID, "target_id", targetID)
	return user, nil
}

// quoteNickname renders a nickname for an audit detail: the value Go-quoted
// (so a quote or " -> " inside it stays unambiguous), or (none) when unset.
func quoteNickname(n *string) string {
	if n == nil || *n == "" {
		return "(none)"
	}
	return strconv.Quote(*n)
}
