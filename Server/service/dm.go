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

// DMService handles direct message channel operations.
type DMService struct {
	st    Store
	perms *PermissionService
	// liveStatus returns userID's live status: the one their WebSocket
	// connection last stamped or chose, "" when they have no connection or
	// it has not stamped one yet. It is wired by the ws layer
	// (Hub.LiveStatus) after both are constructed, so every DM payload this
	// service builds applies the rules ws/serve_ready.go's
	// presentableMembers/presentableDMChannels apply to the ready payload
	// and members list, rather than trusting users.status: that row keeps a
	// *chosen* idle/dnd/invisible across a disconnect by design, and trails
	// a connect by the batched connect stamp. nil (the zero value, e.g. in
	// tests and any caller with no hub) means "no live-connection
	// information available" and leaves the row's status untouched.
	liveStatus func(userID int64) string
}

// NewDMService creates a DMService. perms answers whether an actor is timed
// out, which refuses the writes here that publish to other participants.
func NewDMService(st Store, perms *PermissionService) *DMService {
	return &DMService{st: st, perms: perms}
}

// SetLiveStatusLookup wires the live-status lookup every DM payload this
// service builds presents instead of users.status. Passing nil clears it.
// Safe to call once at startup (the ws layer, after constructing both the
// Hub and the Services) or from a test.
func (s *DMService) SetLiveStatusLookup(liveStatus func(userID int64) string) {
	s.liveStatus = liveStatus
}

// PresentableStatus returns the status viewerID should see for subjectID:
// offline when subjectID holds no stamped live connection, otherwise their
// live status with db.StatusForViewer applied, whatever status (the
// users.status row) says. Exported so a caller that hand-builds a db.DMUser
// outside this package (POST /dms) applies the identical rule
// DMSummaryFor/ListDMs/CreateGroupDM apply via presentableDMChannelInfo
// below. A lookup that was never wired (SetLiveStatusLookup not called, e.g.
// in most tests) leaves status untouched.
func (s *DMService) PresentableStatus(subjectID, viewerID int64, status string) string {
	if s.liveStatus == nil {
		return status
	}
	if live := s.liveStatus(subjectID); live != "" {
		return db.StatusForViewer(live, subjectID, viewerID)
	}
	return db.StatusOffline
}

// presentableDMUser applies PresentableStatus to one DM participant.
func (s *DMService) presentableDMUser(u db.DMUser, viewerID int64) db.DMUser {
	u.Status = s.PresentableStatus(u.ID, viewerID, u.Status)
	return u
}

// presentableDMChannelInfo applies PresentableStatus to every participant of
// a DM payload — Recipient (the legacy single-recipient field) and every
// entry of Recipients, since a 1:1 DM's Recipient is a copy of
// Recipients[0], not a shared reference. Mirrors Hub.presentableDMChannels
// (ws/serve_ready.go) at the service layer so every REST response and push
// event built from a db.DMChannelInfo need not duplicate the rule itself.
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
	// RecipientOpened reports whether the recipient's side is actually open
	// and safe to announce (dm_channel_open, ready.dm_channels, GET /dms).
	// Only meaningful when Created is true — GetOrCreateDMChannelGated's
	// existing-channel branch never touches the other party's dm_open_state,
	// so an existing channel's visibility is whatever it already was.
	// A brand-new one-to-one channel opens only the recipient's side too
	// when the recipient already trusts the caller, decided atomically
	// inside GetOrCreateDMChannelGated's own transaction — otherwise only
	// the caller's side opens, and the recipient's opens at acceptance
	// instead (MessageRequestService.Accept / AcceptMessageRequest).
	// RecipientOpened tells the caller (api/dm_handler.go) whether to
	// broadcast dm_channel_open.
	RecipientOpened bool
	// AcceptedRequest is the caller's own undecided message request from the
	// other user that opening the DM just accepted (db.GetOrCreateDMChannelGated),
	// so the caller can send the same dm_request update Accept does. Nil
	// otherwise.
	AcceptedRequest *db.MessageRequest
}

// dmReachableUser reports whether u can be the other side of a new DM or a
// group DM membership: the account exists, is active (not awaiting approval
// and not denied), and is not effectively banned. A temporary ban that has
// lapsed counts as not banned (auth.IsEffectivelyBanned).
func dmReachableUser(u *db.User) bool {
	return u != nil && u.RegistrationStatus == db.RegistrationActive && !auth.IsEffectivelyBanned(u)
}

// CreateDM creates or retrieves a DM channel between two users.
// Validates that neither user has blocked the other and that the recipient
// accepts direct messages from the caller.
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
	// Only active, not-banned accounts can be reached; anything else is the
	// same "recipient not found" as an unknown id.
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
	// The recipient may have turned off direct messages from members. A
	// trusted sender (accepted, sent_first, grandfathered) still reaches them,
	// which includes a recipient opening a DM they were first written to in.
	// Same refusal as a block, so the two causes read alike.
	refused, err := storeDMReader{s.st}.DMRefusesSender(ctx, recipientID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM privacy: %w", ErrInternal, err)
	}
	if refused {
		return nil, fmt.Errorf("%w: %s", ErrForbidden, dmUnreachableText)
	}

	// A new channel can notify the recipient (dm_channel_open), which a
	// timeout refuses like a send; reopening an existing one notifies nobody.
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

	// The recipient's visibility is decided
	// INSIDE GetOrCreateDMChannelGated's own transaction (does the recipient
	// already trust the caller?) and written once, atomically, with the
	// channel and participants — no separate post-hoc CloseDM call for a
	// cancellation, a CloseDM failure, or a stale read racing an
	// in-flight accept to land in.
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
	// GetUserDMChannels only applies db.StatusForViewer (invisible ->
	// offline); apply the "no live connection" half too, see
	// presentableDMChannelInfo.
	for i := range dms {
		dms[i] = s.presentableDMChannelInfo(dms[i], userID)
	}
	return dms, nil
}

// CloseDMResult describes what closing a DM actually did, so the caller knows
// which events to send.
type CloseDMResult struct {
	// Left is true when the caller left a *group* DM: they are no longer a
	// participant, and the remaining members need to be told.
	Left bool
	// ChannelDeleted is true when the caller was the last participant of a
	// group and the channel row went with them.
	ChannelDeleted bool
	// RemainingParticipantIDs is who is still in the group after a leave. Empty
	// for a 1:1 close, which changes nothing for the other party.
	RemainingParticipantIDs []int64
	// Rows are the group_leave row to fan out to the survivors. Empty for a
	// 1:1 close and when the leaver was the last member.
	Rows []GroupEventRow
}

// CloseDM closes a DM channel for a user.
//
// For a 1:1 DM this hides the conversation from the caller's sidebar and
// nothing more — the other party keeps their copy, and the next message from
// either side re-opens it. For a group DM it is a *leave*: the caller comes
// out of dm_participants, stops receiving the group's messages, and cannot
// re-open it without being re-added. The two meanings share a route because
// they share a gesture ("get this out of my list"), but they are different
// operations and the result says which one ran.
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
			// Removed (or already gone) between the membership check and the tx.
			return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
		}
		return nil, fmt.Errorf("%w: failed to leave group DM: %w", ErrInternal, err)
	}

	// The leave has committed: the reads below must not fail because the client
	// hung up right after, or the survivors would never hear of it.
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

// ─── Group DMs ──────────────────────────────────────────────────────────────

// MaxGroupDMNameLen bounds the optional group name. It matches the channel
// name cap: a group DM name renders in the same sidebar row a channel name
// does, so a longer one would only ever be shown clipped.
const MaxGroupDMNameLen = 100

// CreateGroupDMResult holds the result of creating a group DM.
type CreateGroupDMResult struct {
	Channel      *db.Channel
	Participants []db.DMUser
	// ParticipantIDs is every member including the creator, which is the set
	// the caller fans dm_channel_open out to.
	ParticipantIDs []int64
}

// CreateGroupDM creates a group DM between the caller and 2..8 other users
// (3..10 total, matching db.MaxGroupDMParticipants).
//
// Blocks are enforced in both directions, per recipient: a user cannot pull
// someone they have blocked into a room with them, and cannot use a group to
// reach someone who blocked them. A recipient who has turned off direct
// messages from members and does not trust the caller, or whom the caller
// holds an unaccepted message request to, is refused the same way. The check
// is deliberately *creation-time only* — once the group exists, sending into
// it is not block-checked, because a group DM is a shared room and silently
// dropping one member's messages for one other member would make the
// conversation lie to everybody in it. That is also why the composer gate on
// the client applies to 1:1 DMs alone, and why a member who later turns DMs
// off stays in the group.
//
// Unlike CreateDM this always creates a new channel: the same set of people may
// want more than one group, so there is no "the group for these users" to find.
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

	// Bound the raw bytes before cleanText (sanitizeToFixpoint)
	// runs — see cleanTextBounded's doc comment (user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	// The same checks an add runs, so the two cannot drift: recipients are
	// dmReachableUser, no pair in the room is blocked, and each recipient is
	// reachable by the creator. The send-time gate (RequireDMReachable) skips
	// groups entirely, so this check is the only one: two mutually-blocked
	// recipients must not both end up in the same group even when neither of
	// them blocked the creator.
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

	// The channel, all dm_participants rows and all dm_open_state rows are
	// already committed at this point, so this read must not turn a fully-
	// persisted group DM into a reported failure: it runs
	// uncancellable (context.WithoutCancel) so a client disconnect landing
	// right after the commit can't fail it via ctx.Err(), and any other
	// failure is logged rather than propagated so the caller still gets a
	// usable result to fan dm_channel_open out from. Group DMs are
	// duplicate-by-design — there is no "the group for these users" to find —
	// so telling the caller creation failed when it actually committed only
	// invites a retry that creates a second, indistinguishable group.
	participants, err := s.st.GetDMParticipants(context.WithoutCancel(ctx), ch.ID, userID)
	if err != nil {
		slog.Error("DMService.CreateGroupDM: failed to read participants after commit", "err", err, "channel_id", ch.ID)
		participants = nil
	}
	// See presentableDMChannelInfo: a participant with no live connection
	// must read as offline, whatever users.status stored for them.
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

// RenameGroupDM sets (or, with an empty name, clears) a group DM's name.
//
// Any participant may rename it (Discord's rule; the owner has more authority
// over membership, not over the name). A changed name also writes a
// group_rename row, in the same transaction, returned in Rows for the caller
// to fan out. A name equal to the current one writes no row and returns none.
// A 1:1 DM refuses: its name is who is in it.
func (s *DMService) RenameGroupDM(ctx context.Context, userID, channelID int64, name string) (*RenameGroupResult, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	// The new name is pushed to every participant: text of the caller's own.
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

	// Bound the raw bytes before cleanText (sanitizeToFixpoint)
	// runs — see cleanTextBounded's doc comment (user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	actor, _ := s.st.GetUserByID(ctx, userID) //nolint:errcheck // a failed lookup only changes the fallback text
	change, err := s.st.SetGroupDMName(ctx, channelID, userID, cleanName, groupRenameContent(actor, cleanName))
	if err != nil {
		return nil, mapGroupDBError("failed to rename group DM", err)
	}

	// The rename has committed: the reads below must not fail because the
	// client hung up right after, or the members would never hear of it.
	ctx = context.WithoutCancel(ctx)
	return &RenameGroupResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs}, nil
}

// DMSummaryFor returns one DM's payload shape as viewerID sees it: the group
// name, the participants other than them, and whether it is a group.
//
// Every push of a DM's membership — group create, rename, leave — goes through
// it, so the shape a client receives from an event is the same one it receives
// from GET /dms and from `ready`. Membership is checked here rather than by
// each caller.
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
	// See presentableDMChannelInfo: this is the single place broadcastDMOpen
	// (group create/rename/leave refresh) and PATCH /dms/{id}'s response
	// build their payload from, so applying the "no live connection" rule
	// here covers every push of a DM's membership.
	return s.presentableDMChannelInfo(db.NewDMChannelInfo(channelID, ch.Name, isGroup, ownerID, iconID, participants, viewerID), viewerID), nil
}

// SharedOneToOneDM returns the id of the 1:1 DM channel the two users share,
// or ok=false when they have none. Group DMs never match, mirroring the
// block-enforcement boundary (RequireDMReachable exempts groups).
func (s *DMService) SharedOneToOneDM(ctx context.Context, userA, userB int64) (int64, bool, error) {
	id, ok, err := s.st.FindDMChannelIDBetween(ctx, userA, userB)
	if err != nil {
		return 0, false, fmt.Errorf("%w: failed to look up shared DM: %w", ErrInternal, err)
	}
	return id, ok, nil
}

// RingTargets returns the other participants of a DM the caller is in — the
// people a call_ring is addressed to. A timed-out caller is refused, as for a
// send.
//
// Ringing carries no state: a "call" in a DM *is* somebody being present in
// that DM's voice channel, and the ring is a nudge to come look. That is why
// this is a permission check and a fan-out list rather than a call record —
// there is nothing to persist that presence does not already say, and a
// persisted call would be one more thing that can be left dangling by a crash.
func (s *DMService) RingTargets(ctx context.Context, userID, channelID int64) ([]int64, error) {
	return s.callTargets(ctx, userID, channelID, true)
}

// DeclineTargets is RingTargets for a call_decline. A decline carries no text
// and only stops the ringer's client ringing, so a timeout does not refuse it.
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
	// A ring is a DM interaction like any other sink: without this check a
	// blocked user could still make the blocker's client ring (A-2026-08-03).
	// Group DMs are exempt inside RequireDMReachable, matching every other
	// sink — blocks are enforced at group creation instead.
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

	// Call_incoming/call_declined is a DM interaction
	// like chat, typing and reactions — an untrusted recipient of a pending
	// request must not learn the sender is present in voice either. Group
	// DMs are untouched, matching the block check above.
	//
	// A failed IsGroupDM lookup used to skip the
	// trust filter entirely and ring every participant — fail closed
	// instead: no ring targets at all rather than an unfiltered ring.
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
				// Tell the ringer at once rather than letting them
				// wait out a ring nobody will hear. A decline stays silent.
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
