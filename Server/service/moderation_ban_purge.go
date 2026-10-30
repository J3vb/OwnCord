package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const (
	// banPurgeMaxRows bounds one ban purge. Past it the purge stops and
	// reports itself incomplete; running the same purge again continues.
	banPurgeMaxRows = 10000
	// banPurgeMaxWindow is the longest history window a ban purge accepts.
	banPurgeMaxWindow = 7 * 24 * time.Hour
	// banPurgeRateLimit and banPurgeRateWindow cap how often one actor may
	// start a ban purge, so purges cannot queue behind banPurgeSem.
	banPurgeRateLimit  = 1
	banPurgeRateWindow = 2 * time.Second
)

// BanPurgeBatch is one committed batch of a ban purge: message ids soft-deleted
// in one channel, ready to broadcast as one chat_bulk_deleted.
type BanPurgeBatch struct {
	ChannelID  int64
	MessageIDs []int64
}

// BanPurgeResult is PurgeAfterBan's outcome. Batches lists every batch that
// committed, including when Err is set, so the caller can broadcast them.
// Complete is false when the purge stopped early (row cap, context end or an
// error) and more of the target's messages in the window may remain.
type BanPurgeResult struct {
	Batches  []BanPurgeBatch
	Deleted  int
	Complete bool
	Err      error
}

// authorizeBanPurge runs the permission, existence and rank checks of a ban purge
// without consuming the rate limit and returns the target. Authority comes first
// (as in BanUser) so an actor without it learns nothing about which ids exist.
func (s *ModerationService) authorizeBanPurge(ctx context.Context, actorID, targetID int64) (*db.User, error) {
	if err := requireHumanActor(actorID); err != nil {
		return nil, err
	}
	if targetID <= 0 {
		return nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, fmt.Errorf("%w: cannot ban yourself", ErrBadRequest)
	}
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return nil, err
	}
	if _, err := s.requirePerm(ctx, actorID, permissions.ManageMessages); err != nil {
		return nil, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return nil, err
	}
	return target, nil
}

// AuthorizeBanPurge runs every precondition of purging a member's recent messages
// along with a ban, changing nothing: BAN_MEMBERS and MANAGE_MESSAGES, the target
// exists, the actor strictly outranks it, and the actor is inside the rate limit.
// A caller that bans and purges in one request calls it before the ban commits, so
// a refusal leaves nothing half-applied.
func (s *ModerationService) AuthorizeBanPurge(ctx context.Context, actorID, targetID int64) error {
	if _, err := s.authorizeBanPurge(ctx, actorID, targetID); err != nil {
		return err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("ban_purge", actorID), banPurgeRateLimit, banPurgeRateWindow) {
		return ErrRateLimited
	}
	return nil
}

// PurgeAfterBan soft-deletes the target's messages within window in every channel
// where the actor holds READ_MESSAGES|MANAGE_MESSAGES, after the target was
// banned. It repeats the authorization checks and requires the target to be
// banned now, so it is never a purge without a ban.
// Lock order: banPurgeSem is taken before any other lock and never while one is
// held; mentionEmitMu and the database writer are taken inside it. No hub lock.
func (s *ModerationService) PurgeAfterBan(ctx context.Context, actorID, targetID int64, window time.Duration) BanPurgeResult {
	if window <= 0 || window > banPurgeMaxWindow {
		return BanPurgeResult{Err: fmt.Errorf("%w: invalid purge window", ErrBadRequest)}
	}
	// The window is measured from the request, not from when the wait below
	// ends.
	since := time.Now().UTC().Add(-window).Format(dbtime.SQLiteLayout)
	if s.messages == nil {
		return BanPurgeResult{Err: fmt.Errorf("%w: message purge unavailable", ErrInternal)}
	}

	select {
	case s.banPurgeSem <- struct{}{}:
		defer func() { <-s.banPurgeSem }()
	case <-ctx.Done():
		return BanPurgeResult{Err: fmt.Errorf("ban purge: %w", ctx.Err())}
	}

	// Checked after the wait, so a role change or unban while queued applies.
	target, err := s.authorizeBanPurge(ctx, actorID, targetID)
	if err != nil {
		return BanPurgeResult{Err: err}
	}
	if !auth.IsEffectivelyBanned(target) {
		return BanPurgeResult{Err: fmt.Errorf("%w: user is not banned", ErrBadRequest)}
	}

	maxRows := banPurgeMaxRows
	if s.banPurgeRowCap > 0 {
		maxRows = s.banPurgeRowCap
	}
	batches, complete, purgeErr := s.messages.purgeUserMessagesSince(ctx, actorID, targetID, since, maxRows)

	res := BanPurgeResult{Batches: batches, Complete: complete && purgeErr == nil, Err: purgeErr}
	for _, b := range batches {
		res.Deleted += len(b.MessageIDs)
	}
	if res.Deleted == 0 {
		return res
	}

	// The ledger and audit rows must survive a request canceled after the
	// deletes committed; a failure to write either is logged and the deletes
	// stand.
	wc := context.WithoutCancel(ctx)
	if err := s.st.RecordRemovalAction(wc, targetID, actorID, fmt.Sprintf("%d messages removed with ban", res.Deleted)); err != nil {
		slog.Error("ModerationService.PurgeAfterBan record removal", "err", err, "actor_id", actorID, "target_id", targetID)
	}
	db.WriteAudit(wc, s.st, actorID, "user_ban_purge", "user", targetID,
		fmt.Sprintf("deleted %d messages from the last %d seconds", res.Deleted, int64(window/time.Second)))

	slog.Info("ban purge", "actor_id", actorID, "target_id", targetID, "count", res.Deleted, "complete", res.Complete)
	return res
}

// purgeUserMessagesSince soft-deletes userID's messages at or after since, channel
// by channel in batches of maxPurgeLimit, up to maxRows. A channel is covered only
// when actorID holds READ_MESSAGES and MANAGE_MESSAGES there; a lookup error skips
// it. It returns every committed batch even when it stops early (complete false at
// the row cap, context end, or a store error returned as err).
func (s *MessageService) purgeUserMessagesSince(ctx context.Context, actorID, userID int64, since string, maxRows int) (batches []BanPurgeBatch, complete bool, err error) {
	channels, err := s.st.ListUserMessageChannelsSince(ctx, userID, since)
	if err != nil {
		slog.Error("ModerationService.PurgeAfterBan list channels", "err", err, "target_id", userID)
		return nil, false, fmt.Errorf("%w: failed to list channels", ErrInternal)
	}

	total := 0
	for _, chID := range channels {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return batches, false, fmt.Errorf("ban purge: %w", ctxErr)
		}
		if !s.canModerateDelete(ctx, actorID, chID) {
			continue
		}

		// Flush queued mention-badge increments before the batches commit and the reversal
		// below runs, as PurgeMessages does.
		s.flushChannelMentionCounts(context.WithoutCancel(ctx), chID)

		for {
			remaining := maxRows - total
			if remaining <= 0 {
				return batches, false, nil
			}
			n := min(maxPurgeLimit, remaining)
			ids, purgeErr := s.st.PurgeUserChannelMessagesSince(ctx, chID, userID, since, n)
			if purgeErr != nil {
				if errors.Is(purgeErr, context.Canceled) || errors.Is(purgeErr, context.DeadlineExceeded) {
					return batches, false, fmt.Errorf("ban purge: %w", purgeErr)
				}
				slog.Error("ModerationService.PurgeAfterBan purge batch", "err", purgeErr, "channel_id", chID)
				return batches, false, fmt.Errorf("%w: failed to purge messages", ErrInternal)
			}
			if len(ids) > 0 {
				if mcErr := s.reverseMentionCounts(context.WithoutCancel(ctx), chID, ids); mcErr != nil {
					slog.Error("ModerationService.PurgeAfterBan DecrementMentionCounts", "err", mcErr, "channel_id", chID)
				}
				batches = append(batches, BanPurgeBatch{ChannelID: chID, MessageIDs: ids})
				total += len(ids)
			}
			if len(ids) < n {
				break
			}
		}
	}
	return batches, true, nil
}

// canModerateDelete reports whether actorID may delete others' messages in
// chID under the message delete policy; a lookup error counts as no.
func (s *MessageService) canModerateDelete(ctx context.Context, actorID, chID int64) bool {
	subj, err := s.perms.Subject(ctx, actorID, chID)
	if err != nil {
		slog.Debug("ban purge: channel skipped", "channel_id", chID, "lookup_failed", true)
		return false
	}
	asModerator, err := permissions.CanDeleteMessage(subj, false)
	if err != nil || !asModerator {
		slog.Debug("ban purge: channel skipped", "channel_id", chID, "lookup_failed", false)
		return false
	}
	return true
}

// ValidateActionReason applies BanUser's moderation reason rules (length, control
// characters) so a caller can reject a bad reason before spending a rate-limit
// token.
func ValidateActionReason(reason string) error {
	return validateActionReason(reason)
}

// SetBanPurgeRowCapForTest lowers the number of messages one ban purge may
// delete before it reports itself incomplete. It is for tests only; n <= 0
// restores the default.
func (s *ModerationService) SetBanPurgeRowCapForTest(n int) { s.banPurgeRowCap = n }
