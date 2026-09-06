package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ErrNotNSFW is returned when the caller tries to acknowledge a channel that
// is not labelled — there is nothing to consent to. The api layer maps it to
// its own 409 NOT_NSFW code rather than the generic CONFLICT.
var ErrNotNSFW = errors.New("channel is not labelled nsfw")

// NSFWService owns the per-user, per-channel acknowledgement row (migration
// 047, B5-7, decision 13): whether a channel's labelled content may reach a
// given reader. See docs/architecture/community-services.md section S4 for
// the abuse cases and data-ownership rules this backs, and
// permissions.CanReadContent for the predicate every content path resolves
// this row into.
type NSFWService struct {
	st    Store
	perms *PermissionService
}

// NewNSFWService creates an NSFWService.
func NewNSFWService(st Store, perms *PermissionService) *NSFWService {
	return &NSFWService{st: st, perms: perms}
}

// checkVisible resolves channelID and asserts the caller may see it at all
// (permissions.CanViewChannel — visibility, not content): the acknowledge/
// revoke endpoints ask nothing more than the channel already answers to
// every other visibility-gated surface (ready, the sidebar). A channel the
// caller cannot see is reported as ErrNotFound, matching every other
// visibility refusal in this package.
func (s *NSFWService) checkVisible(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return fmt.Errorf("%w: failed to resolve permissions", ErrInternal)
	}
	if permissions.CanViewChannel(sub) != nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return nil
}

// nsfwAcknowledgeRaceHook, when non-nil, runs once per Acknowledge call
// immediately after checkVisible succeeds and immediately before the atomic
// insert (P2-2). Test-only (always nil in production): lets a test unlabel
// the channel exactly in that window, reproducing the interleaving Codex
// flagged deterministically instead of chasing a real goroutine race.
var nsfwAcknowledgeRaceHook func()

// Acknowledge records userID's consent to channelID's labelled content.
// Idempotent (the underlying INSERT OR IGNORE): acknowledging twice succeeds
// silently. Refuses ErrNotFound on an invisible channel and ErrNotNSFW on
// one that is not labelled — there is nothing to acknowledge.
//
// P2-2: the label check and the insert are ONE statement
// (db.AcknowledgeNSFW), so a relabel or unlabel landing between a separate
// check and a separate insert can no longer make this trust stale consent.
// Rows-affected 0 means either "already acknowledged" or "not labelled" —
// db.AcknowledgeNSFW can't tell those apart from its own return value, so a
// live HasNSFWAcknowledgement read disambiguates.
func (s *NSFWService) Acknowledge(ctx context.Context, userID, channelID int64) error {
	if err := s.checkVisible(ctx, userID, channelID); err != nil {
		return err
	}
	if nsfwAcknowledgeRaceHook != nil {
		nsfwAcknowledgeRaceHook()
	}
	inserted, err := s.st.AcknowledgeNSFW(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("%w: failed to record acknowledgement", ErrInternal)
	}
	if inserted {
		return nil
	}
	ok, err := s.st.HasNSFWAcknowledgement(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("%w: failed to verify acknowledgement", ErrInternal)
	}
	if !ok {
		return ErrNotNSFW
	}
	return nil
}

// Revoke deletes userID's acknowledgement of channelID, taking effect on the
// caller's very next read. Idempotent: revoking a row that does not exist
// (never acknowledged, or the channel was since unlabelled and its rows
// already cleared) succeeds silently — there is no "not labelled" refusal
// here, because revoking is safe regardless of the channel's current label
// state. Still requires visibility (ErrNotFound), matching Acknowledge.
func (s *NSFWService) Revoke(ctx context.Context, userID, channelID int64) error {
	if err := s.checkVisible(ctx, userID, channelID); err != nil {
		return err
	}
	if err := s.st.RevokeNSFW(ctx, userID, channelID); err != nil {
		return fmt.Errorf("%w: failed to remove acknowledgement", ErrInternal)
	}
	return nil
}
