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
	// banPurgeMaxRows bounds one ban purge; past it the purge reports itself incomplete and running it again
	// continues.
	banPurgeMaxRows = 10000
	// banPurgeMaxWindow is the longest history window a ban purge accepts.
	banPurgeMaxWindow = 7 * 24 * time.Hour
	// banPurgeRateLimit and banPurgeRateWindow cap how often one actor may start a ban purge, so purges cannot
	// queue behind banPurgeSem.
	banPurgeRateLimit  = 1
	banPurgeRateWindow = 2 * time.Second
)

// BanPurgeBatch is one committed batch: message ids soft-deleted in one channel, to broadcast as one
// chat_bulk_deleted.
type BanPurgeBatch struct {
	ChannelID  int64
	MessageIDs []int64
}

// BanPurgeResult is PurgeAfterBan's outcome. Batches lists every committed batch, even when Err is set.
// Complete is false when the purge stopped early (row cap, context end, error).
type BanPurgeResult struct {
	Batches  []BanPurgeBatch
	Deleted  int
	Complete bool
	Err      error
}

// authorizeBanPurge runs the permission, existence and rank checks without consuming the rate limit.
// Authority comes first (as in BanUser) so an actor without it learns nothing about which ids exist.
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

// AuthorizeBanPurge runs every precondition of a ban purge, changing nothing: BAN_MEMBERS and
// MANAGE_MESSAGES, target exists, actor strictly outranks it, actor inside the rate limit. A ban-and-purge
// request calls it before the ban commits so a refusal leaves nothing half-applied.
func (s *ModerationService) AuthorizeBanPurge(ctx context.Context, actorID, targetID int64) error {
	if _, err := s.authorizeBanPurge(ctx, actorID, targetID); err != nil {
		return err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("ban_purge", actorID), banPurgeRateLimit, banPurgeRateWindow) {
		return ErrRateLimited
	}
	return nil
}

// PurgeAfterBan soft-deletes the target's messages within window in every channel where the actor holds
// READ_MESSAGES|MANAGE_MESSAGES. It repeats the authorization checks and requires the target to be banned
// now. Lock order: banPurgeSem is taken before any other lock and never while one is held; the channel
// mention emit lock and the database writer are taken inside it. No hub lock.
func (s *ModerationService) PurgeAfterBan(ctx context.Context, actorID, targetID int64, window time.Duration) BanPurgeResult {
	if window <= 0 || window > banPurgeMaxWindow {
		return BanPurgeResult{Err: fmt.Errorf("%w: invalid purge window", ErrBadRequest)}
	}
	// The window is measured from the request, not from when the wait ends.
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

	// Ledger and audit rows must survive a request canceled after the deletes committed; a failed write is
	// logged and the deletes stand.
	wc := context.WithoutCancel(ctx)
	if err := s.st.RecordRemovalAction(wc, targetID, actorID, fmt.Sprintf("%d messages removed with ban", res.Deleted)); err != nil {
		slog.Error("ModerationService.PurgeAfterBan record removal", "err", err, "actor_id", actorID, "target_id", targetID)
	}
	db.WriteAudit(wc, s.st, actorID, "user_ban_purge", "user", targetID,
		fmt.Sprintf("deleted %d messages from the last %d seconds", res.Deleted, int64(window/time.Second)))

	slog.Info("ban purge", "actor_id", actorID, "target_id", targetID, "count", res.Deleted, "complete", res.Complete)
	return res
}

// purgeUserMessagesSince soft-deletes userID's messages at or after since, channel by channel in batches of
// maxPurgeLimit, up to maxRows. A channel is covered only when actorID holds READ_MESSAGES and
// MANAGE_MESSAGES there; a lookup error skips it. Returns every committed batch even when stopping early.
func (s *messageRemoval) purgeUserMessagesSince(ctx context.Context, actorID, userID int64, since string, maxRows int) (batches []BanPurgeBatch, complete bool, err error) {
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

		// Flush queued mention increments before the batches commit, as PurgeMessages does.
		s.mentions.flushChannelMentionCounts(context.WithoutCancel(ctx), chID)

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
				if mcErr := s.mentions.reverseMentionCounts(context.WithoutCancel(ctx), chID, ids); mcErr != nil {
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

// canModerateDelete reports whether actorID may delete others' messages in chID under the delete policy; a
// lookup error counts as no.
func (s *messageRemoval) canModerateDelete(ctx context.Context, actorID, chID int64) bool {
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

// ValidateActionReason applies BanUser's reason rules (length, control characters) so a caller can reject
// before spending a rate-limit token.
func ValidateActionReason(reason string) error {
	return validateActionReason(reason)
}

// SetBanPurgeRowCapForTest lowers the ban purge row cap for tests; n <= 0 restores the default.
func (s *ModerationService) SetBanPurgeRowCapForTest(n int) { s.banPurgeRowCap = n }
