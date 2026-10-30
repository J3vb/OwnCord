package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// DMService handles direct-message channel operations.
type DMService struct {
	st    Store
	perms *PermissionService
	// liveStatus returns userID's live status (what their connection last stamped or
	// chose), "" with no connection or no stamp. The ws layer wires it
	// (Hub.LiveStatus) so DM payloads apply the rules of ws/serve_ready.go's
	// presentableMembers/presentableDMChannels instead of users.status, which keeps
	// a chosen idle/dnd/invisible across a disconnect and trails a connect by the
	// batched stamp. Nil (tests, no hub) leaves the row's status untouched.
	liveStatus func(userID int64) string
}

// NewDMService creates a DMService. perms answers whether an actor is timed out,
// which refuses the writes that publish to other participants.
func NewDMService(st Store, perms *PermissionService) *DMService {
	return &DMService{st: st, perms: perms}
}

// SetLiveStatusLookup wires the live-status lookup DM payloads present instead of
// users.status; nil clears it. Call once at startup or from a test.
func (s *DMService) SetLiveStatusLookup(liveStatus func(userID int64) string) {
	s.liveStatus = liveStatus
}

// PresentableStatus returns the status viewerID should see for subjectID: offline
// with no stamped live connection, else the live status through
// db.StatusForViewer, whatever users.status says. Exported so POST /dms, which
// hand-builds a db.DMUser, applies the same rule. An unwired lookup leaves status
// untouched.
func (s *DMService) PresentableStatus(subjectID, viewerID int64, status string) string {
	if s.liveStatus == nil {
		return status
	}
	if live := s.liveStatus(subjectID); live != "" {
		return db.StatusForViewer(live, subjectID, viewerID)
	}
	return db.StatusOffline
}

func (s *DMService) presentableDMUser(u db.DMUser, viewerID int64) db.DMUser {
	u.Status = s.PresentableStatus(u.ID, viewerID, u.Status)
	return u
}

// presentableDMChannelInfo applies PresentableStatus to Recipient (the legacy
// single field, a copy of Recipients[0], not a shared reference) and every entry
// of Recipients. Mirrors Hub.presentableDMChannels (ws/serve_ready.go).
func (s *DMService) presentableDMChannelInfo(info db.DMChannelInfo, viewerID int64) db.DMChannelInfo {
	if info.Recipient.ID != 0 {
		info.Recipient = s.presentableDMUser(info.Recipient, viewerID)
	}
	for i := range info.Recipients {
		info.Recipients[i] = s.presentableDMUser(info.Recipients[i], viewerID)
	}
	return info
}

// CreateDMResult holds the result of creating or fetching a DM channel.
type CreateDMResult struct {
	Channel   *db.Channel
	Created   bool
	Recipient *db.User
	// RecipientOpened reports whether the recipient's side is open and safe to
	// announce (dm_channel_open, ready.dm_channels, GET /dms). Meaningful only when
	// Created: an existing channel's visibility is untouched. A new 1:1 channel opens
	// the recipient's side only if the recipient already trusts the caller (decided
	// atomically in GetOrCreateDMChannelGated's transaction); otherwise it opens at
	// acceptance (MessageRequestService.Accept). The caller (api/dm_handler.go)
	// broadcasts dm_channel_open from it.
	RecipientOpened bool
	// AcceptedRequest is the caller's own undecided request from the other user that
	// opening the DM just accepted, so the caller can send Accept's dm_request update.
	AcceptedRequest *db.MessageRequest
}

// dmReachableUser reports whether u can be the other side of a new DM or group
// membership: the account exists, is active (not pending or denied) and is not
// effectively banned (a lapsed temporary ban counts as not banned).
func dmReachableUser(u *db.User) bool {
	return u != nil && u.RegistrationStatus == db.RegistrationActive && !auth.IsEffectivelyBanned(u)
}

// CreateDM creates or retrieves a DM channel between two users, validating that
// neither blocked the other and the recipient accepts DMs from the caller.
func (s *DMService) CreateDM(ctx context.Context, userID, recipientID int64) (*CreateDMResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.CreateDM",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("recipient_id", recipientID),
	)
	defer done()

	if recipientID <= 0 {
		return nil, fmt.Errorf("%w: recipient_id must be positive", ErrBadRequest)
	}
	if userID == recipientID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", ErrBadRequest)
	}

	recipient, err := s.st.GetUserByID(ctx, recipientID)
	if err != nil || recipient == nil {
		return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
	}
	// Anything not active and unbanned is the same "recipient not found" as an
	// unknown id.
	if !dmReachableUser(recipient) {
		return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
	}

	blocked, err := s.st.IsEitherBlocked(ctx, userID, recipientID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check block status: %w", ErrInternal, err)
	}
	if blocked {
		return nil, fmt.Errorf("%w: %s", ErrForbidden, dmUnreachableText)
	}
	// The recipient may have turned off DMs from members; a trusted sender (accepted,
	// sent_first, grandfathered) still reaches them. Same refusal as a block, so the
	// two causes read alike.
	refused, err := storeDMReader{s.st}.DMRefusesSender(ctx, recipientID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM privacy: %w", ErrInternal, err)
	}
	if refused {
		return nil, fmt.Errorf("%w: %s", ErrForbidden, dmUnreachableText)
	}

	// A new channel can notify the recipient (dm_channel_open), which a timeout
	// refuses like a send; reopening an existing one notifies nobody.
	if timeoutErr := requireNotTimedOut(ctx, s.perms, userID); timeoutErr != nil {
		if !errors.Is(timeoutErr, ErrTimedOut) {
			return nil, timeoutErr
		}
		_, exists, err := s.st.FindDMChannelIDBetween(ctx, userID, recipientID)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to look up DM: %w", ErrInternal, err)
		}
		if !exists {
			return nil, timeoutErr
		}
	}

	// The recipient's visibility is decided INSIDE GetOrCreateDMChannelGated's
	// transaction (does the recipient already trust the caller?) and written once with
	// the channel and participants, leaving no post-hoc CloseDM to race a
	// cancellation, failure or in-flight accept.
	ch, created, recipientOpened, accepted, err := s.st.GetOrCreateDMChannelGated(ctx, userID, recipientID)
	if err != nil {
		slog.Error("DMService.CreateDM", "err", err)
		return nil, fmt.Errorf("%w: failed to create DM channel", ErrInternal)
	}

	return &CreateDMResult{
		Channel:         ch,
		Created:         created,
		Recipient:       recipient,
		RecipientOpened: recipientOpened,
		AcceptedRequest: accepted,
	}, nil
}

// ListDMs returns all open DM channels for a user.
func (s *DMService) ListDMs(ctx context.Context, userID int64) ([]db.DMChannelInfo, error) {
	dms, err := s.st.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list DMs: %w", ErrInternal, err)
	}
	// GetUserDMChannels applies only db.StatusForViewer; add the "no live
	// connection" half (see presentableDMChannelInfo).
	for i := range dms {
		dms[i] = s.presentableDMChannelInfo(dms[i], userID)
	}
	return dms, nil
}

// CloseDMResult describes what closing a DM did, so the caller knows which events
// to send.
type CloseDMResult struct {
	// Left is true when the caller left a group DM; the remaining members need telling.
	Left bool
	// ChannelDeleted is true when the caller was the group's last participant.
	ChannelDeleted bool
	// RemainingParticipantIDs is who is left after a leave; empty for a 1:1 close.
	RemainingParticipantIDs []int64
	// Rows are the group_leave rows to fan out; empty for a 1:1 close or a last member.
	Rows []GroupEventRow
}

// CloseDM closes a DM for a user. For a 1:1 DM it only hides the conversation
// from the caller's sidebar (the other party keeps theirs; the next message
// reopens it). For a group DM it is a leave: the caller leaves dm_participants
// and cannot reopen without being re-added. They share a route because they
// share a gesture, but are different operations and the result says which ran.
func (s *DMService) CloseDM(ctx context.Context, userID, channelID int64) (*CloseDMResult, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}

	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM kind: %w", ErrInternal, err)
	}

	if !isGroup {
		if err := s.st.CloseDM(ctx, userID, channelID); err != nil {
			return nil, fmt.Errorf("%w: failed to close DM: %w", ErrInternal, err)
		}
		slog.Debug("DM closed", "user_id", userID, "channel_id", channelID)
		return &CloseDMResult{}, nil
	}

	leaver, _ := s.st.GetUserByID(ctx, userID) //nolint:errcheck // a failed lookup only changes the fallback text
	res, err := s.st.LeaveGroupDM(ctx, userID, channelID, groupLeaveContent(leaver))
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			// Removed (or gone) between the membership check and the tx.
			return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
		}
		return nil, fmt.Errorf("%w: failed to leave group DM: %w", ErrInternal, err)
	}

	// The leave committed: the reads below must not fail on a client hang-up, or the
	// survivors never hear of it.
	ctx = context.WithoutCancel(ctx)
	slog.Debug("group DM left", "user_id", userID, "channel_id", channelID, "deleted", res.Deleted)
	out := &CloseDMResult{
		Left:                    true,
		ChannelDeleted:          res.Deleted,
		RemainingParticipantIDs: res.MemberIDs,
	}
	if res.Row != nil {
		out.Rows = s.groupRows(ctx, []db.GroupEventRow{*res.Row})
	}
	return out, nil
}

// MaxGroupDMNameLen bounds the optional group name; it matches the channel name
// cap since both render in the same sidebar row.
const MaxGroupDMNameLen = 100

// CreateGroupDMResult holds the result of creating a group DM.
type CreateGroupDMResult struct {
	Channel      *db.Channel
	Participants []db.DMUser
	// ParticipantIDs is every member including the creator: the dm_channel_open fan-out set.
	ParticipantIDs []int64
}

// CreateGroupDM creates a group DM between the caller and 2..8 other users
// (3..10 total, db.MaxGroupDMParticipants). Blocks are enforced both ways per
// recipient: a user cannot pull someone they blocked into a room, nor reach
// someone who blocked them via a group. A recipient who turned off DMs from
// members and does not trust the caller, or whom the caller holds an unaccepted
// request to, is refused the same way. The check is deliberately creation-time
// only: a group is a shared room, and silently dropping one member's messages for
// another would make the conversation lie to everybody (so the client composer
// gate applies to 1:1 DMs alone, and a member who later turns DMs off stays).
// Unlike CreateDM it always creates a new channel; the same people may want
// several groups.
func (s *DMService) CreateGroupDM(ctx context.Context, userID int64, recipientIDs []int64, name string) (*CreateGroupDMResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.CreateGroupDM",
		telemetry.Int64("user_id", userID),
	)
	defer done()

	if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
		return nil, err
	}

	unique, err := dedupeGroupRecipients(recipientIDs, userID)
	if err != nil {
		return nil, err
	}

	if len(unique) < 2 {
		return nil, fmt.Errorf("%w: a group DM needs at least 2 other users", ErrBadRequest)
	}
	if len(unique)+1 > db.MaxGroupDMParticipants {
		return nil, fmt.Errorf("%w: a group DM holds at most %d users", ErrBadRequest, db.MaxGroupDMParticipants)
	}

	// Bound the raw bytes before cleanText; see cleanTextBounded (user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	// The same checks an add runs, so they cannot drift: recipients are
	// dmReachableUser, no pair is blocked, each is reachable by the creator. The
	// send-time gate (RequireDMReachable) skips groups, so this is the only check:
	// two mutually-blocked recipients must not share a group even if neither blocked
	// the creator.
	if _, err = s.validateGroupRecipients(ctx, userID, unique, []int64{userID}); err != nil {
		return nil, err
	}
	participantIDs := append([]int64{userID}, unique...)
	ch, err := s.st.CreateGroupDMChannel(ctx, cleanName, userID, participantIDs)
	if errors.Is(err, db.ErrGroupDMBlockedPair) {
		return nil, mapGroupDBError("failed to create group DM", err)
	}
	if err != nil {
		slog.Error("DMService.CreateGroupDM", "err", err)
		return nil, fmt.Errorf("%w: failed to create group DM", ErrInternal)
	}

	// Everything is committed, so this read must not turn a persisted group into a
	// reported failure: it is uncancellable so a disconnect cannot fail it, and any
	// other failure is logged so the caller still gets a result to fan
	// dm_channel_open from. Groups are duplicate-by-design, so reporting a failure
	// would only invite a retry creating a second, indistinguishable group.
	participants, err := s.st.GetDMParticipants(context.WithoutCancel(ctx), ch.ID, userID)
	if err != nil {
		slog.Error("DMService.CreateGroupDM: failed to read participants after commit", "err", err, "channel_id", ch.ID)
		participants = nil
	}
	// A participant with no live connection reads offline (see presentableDMChannelInfo).
	for i := range participants {
		participants[i] = s.presentableDMUser(participants[i], userID)
	}

	return &CreateGroupDMResult{
		Channel:        ch,
		Participants:   participants,
		ParticipantIDs: participantIDs,
	}, nil
}

// RenameGroupResult is what a rename did.
type RenameGroupResult struct {
	// Rows is the group_rename row, empty when the name did not change.
	Rows []GroupEventRow
	// Audience is the members, who receive the refreshed summary and the row.
	Audience []int64
}

// RenameGroupDM sets (or, with "", clears) a group DM's name. Any participant may
// rename (the owner has more authority over membership, not the name). A changed
// name writes a group_rename row in the same transaction, returned in Rows; an
// equal name writes none. A 1:1 DM refuses: its name is who is in it.
func (s *DMService) RenameGroupDM(ctx context.Context, userID, channelID int64, name string) (*RenameGroupResult, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	// The new name is pushed to every participant, so it is the caller's own text.
	if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
		return nil, err
	}

	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM kind: %w", ErrInternal, err)
	}
	if !isGroup {
		return nil, fmt.Errorf("%w: only group DMs can be named", ErrBadRequest)
	}

	// Bound the raw bytes before cleanText; see cleanTextBounded (user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	actor, _ := s.st.GetUserByID(ctx, userID) //nolint:errcheck // a failed lookup only changes the fallback text
	change, err := s.st.SetGroupDMName(ctx, channelID, userID, cleanName, groupRenameContent(actor, cleanName))
	if err != nil {
		return nil, mapGroupDBError("failed to rename group DM", err)
	}

	// The rename committed: the reads below must not fail on a client hang-up, or
	// the members never hear of it.
	ctx = context.WithoutCancel(ctx)
	return &RenameGroupResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs}, nil
}

// DMSummaryFor returns one DM's payload as viewerID sees it: group name,
// participants other than them, group flag. Every push of a DM's membership
// (create, rename, leave) goes through it so events match GET /dms and `ready`.
// Membership is checked here, not by each caller.
func (s *DMService) DMSummaryFor(ctx context.Context, viewerID, channelID int64) (db.DMChannelInfo, error) {
	ok, err := s.st.IsDMParticipant(ctx, viewerID, channelID)
	if err != nil || !ok {
		return db.DMChannelInfo{}, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	participants, err := s.st.GetDMParticipants(ctx, channelID, viewerID)
	if err != nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read DM participants: %w", ErrInternal, err)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read DM kind: %w", ErrInternal, err)
	}
	var ownerID int64
	var iconID string
	if isGroup {
		if ownerID, iconID, err = s.st.GetGroupDMMeta(ctx, channelID); err != nil {
			return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read group owner: %w", ErrInternal, err)
		}
	}
	// The single place broadcastDMOpen and PATCH /dms/{id} build from, so the "no
	// live connection" rule here covers every push (see presentableDMChannelInfo).
	return s.presentableDMChannelInfo(db.NewDMChannelInfo(channelID, ch.Name, isGroup, ownerID, iconID, participants, viewerID), viewerID), nil
}

// SharedOneToOneDM returns the 1:1 DM channel the two users share, or ok=false.
// Group DMs never match (RequireDMReachable exempts groups).
func (s *DMService) SharedOneToOneDM(ctx context.Context, userA, userB int64) (int64, bool, error) {
	id, ok, err := s.st.FindDMChannelIDBetween(ctx, userA, userB)
	if err != nil {
		return 0, false, fmt.Errorf("%w: failed to look up shared DM: %w", ErrInternal, err)
	}
	return id, ok, nil
}

// RingTargets returns the other participants of a DM the caller is in, the people
// a call_ring is addressed to. A timed-out caller is refused, as for a send.
// Ringing carries no state: a "call" in a DM is somebody present in its voice
// channel and the ring a nudge, so there is nothing to persist that presence does
// not say, and a persisted call could dangle after a crash.
func (s *DMService) RingTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	return s.callTargets(ctx, userID, channelID, true)
}

// DeclineTargets is RingTargets for a call_decline. A decline carries no text and
// only stops the ringer's client ringing, so a timeout does not refuse it.
func (s *DMService) DeclineTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	return s.callTargets(ctx, userID, channelID, false)
}

func (s *DMService) callTargets(ctx context.Context, userID, channelID int64, ring bool) ([]int64, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM participation: %w", ErrInternal, err)
	}
	if !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
	}
	// A ring is a DM interaction like any other sink: without this a blocked user
	// could make the blocker's client ring. Groups are exempt inside
	// RequireDMReachable; blocks are enforced at group creation instead.
	if err := RequireDMReachable(ctx, storeDMReader{s.st}, userID, channelID); err != nil {
		return nil, err
	}
	if ring {
		if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
			return nil, err
		}
	}

	ids, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM participants: %w", ErrInternal, err)
	}

	// call_incoming/call_declined is a DM interaction like chat and typing: an
	// untrusted recipient of a pending request must not learn the sender is in voice.
	// Groups are untouched. A failed IsGroupDM must fail closed to no ring targets,
	// not an unfiltered ring.
	isGroup, gErr := s.st.IsGroupDM(ctx, channelID)
	if gErr != nil {
		return nil, nil //nolint:nilerr // fail closed to no targets, not an error — the ringer's own call_ring must still succeed
	}

	targets := make([]int64, 0, len(ids))
	for _, pid := range ids {
		if pid == userID {
			continue
		}
		if !isGroup {
			trusted, tErr := s.st.IsTrustedSender(ctx, pid, userID)
			if tErr == nil && !trusted && ring {
				// Tell the ringer at once rather than let them wait out a ring nobody will hear.
				// A decline stays silent.
				return nil, ErrCallNeedsAcceptance
			}
			if tErr != nil || !trusted {
				continue
			}
		}
		targets = append(targets, pid)
	}
	return targets, nil
}
