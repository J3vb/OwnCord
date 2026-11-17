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

type dmCoreStore interface {
	dmReachStore
	LeaveGroupDM(ctx context.Context, userID, channelID int64, content string) (*db.LeaveGroupResult, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetOrCreateDMChannelGated(ctx context.Context, callerID, recipientID int64) (ch *db.Channel, created, recipientOpened bool, accepted *db.MessageRequest, err error)
	FindDMChannelIDBetween(ctx context.Context, user1ID, user2ID int64) (int64, bool, error)
	GetUserDMChannels(ctx context.Context, userID int64) ([]db.DMChannelInfo, error)
	GetDMHistoryForParticipants(ctx context.Context, channelID int64, userIDs []int64) (map[int64]db.DMHistory, error)
	OpenDMIfParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	CloseDM(ctx context.Context, userID, channelID int64) error
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	CreateGroupDMChannel(ctx context.Context, name string, ownerID int64, participantIDs []int64) (*db.Channel, error)
	GetGroupDMMeta(ctx context.Context, channelID int64) (ownerID int64, iconID string, err error)
	GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]db.DMUser, error)
	IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error)
}

type dmStore interface {
	dmCoreStore
	groupManagementStore
}

// DMService handles direct-message channel operations.
type DMService struct {
	st    dmCoreStore
	perms *PermissionService
	*groupManagement
	// liveStatus returns userID's live status, "" with no connection or stamp. Wired by the ws
	// layer (Hub.LiveStatus) so DM payloads follow ws/serve_ready.go instead of users.status,
	// which keeps a chosen idle/dnd/invisible across a disconnect. Nil leaves the row untouched.
	liveStatus func(userID int64) string
	// liveMobile returns whether userID's live presence is on the Android app (Hub.LiveMobile). Nil leaves every
	// DM user off the phone.
	liveMobile func(userID int64) bool
}

// NewDMService creates a DMService. perms answers whether an actor is timed out, which
// refuses writes that publish to other participants.
func NewDMService(st dmStore, perms *PermissionService) *DMService {
	return &DMService{st: st, perms: perms, groupManagement: &groupManagement{st: st, perms: perms}}
}

// SetLiveStatusLookup wires the live-status lookup DM payloads present instead of users.status; nil
// clears it.
func (s *DMService) SetLiveStatusLookup(liveStatus func(userID int64) string) {
	s.liveStatus = liveStatus
}

// SetLiveMobileLookup wires the lookup DM payloads read the phone flag from; nil clears it.
func (s *DMService) SetLiveMobileLookup(liveMobile func(userID int64) bool) {
	s.liveMobile = liveMobile
}

// PresentableMobile reports whether subjectID shows the phone to a viewer shown them with
// presented status: never while they read as offline.
func (s *DMService) PresentableMobile(subjectID int64, presented string) bool {
	return s.liveMobile != nil && presented != db.StatusOffline && s.liveMobile(subjectID)
}

// PresentableStatus returns the status viewerID should see for subjectID: offline with no
// stamped live connection, else the live status through db.StatusForViewer. Exported so
// POST /dms, which hand-builds a db.DMUser, applies the same rule.
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
	u.Mobile = s.PresentableMobile(u.ID, u.Status)
	return u
}

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
	// RecipientOpened reports whether the recipient's side is open and safe to announce
	// (dm_channel_open, ready.dm_channels, GET /dms); meaningful only when Created. A new 1:1
	// channel opens it only if they already trust the caller (decided in
	// GetOrCreateDMChannelGated's transaction), else at acceptance (MessageRequestService.Accept).
	RecipientOpened bool
	// AcceptedRequest is the caller's own undecided request from the other user that opening the DM just
	// accepted (for Accept's dm_request update).
	AcceptedRequest *db.MessageRequest
}

// dmReachableUser reports whether u can be the other side of a new DM or group: the
// account exists, is active and is not effectively banned (a lapsed temporary ban counts as not banned).
func dmReachableUser(u *db.User) bool {
	return u != nil && u.RegistrationStatus == db.RegistrationActive && !auth.IsEffectivelyBanned(u)
}

// CreateDM creates or retrieves a DM channel between two users, validating that neither
// blocked the other and the recipient accepts DMs from the caller.
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
	// Anything not active and unbanned is the same "recipient not found" as an unknown id.
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
	// sent_first, grandfathered) still reaches them. Same refusal as a block.
	refused, err := storeDMReader{s.st}.DMRefusesSender(ctx, recipientID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM privacy: %w", ErrInternal, err)
	}
	if refused {
		return nil, fmt.Errorf("%w: %s", ErrForbidden, dmUnreachableText)
	}

	// A new channel can notify the recipient (dm_channel_open), which a timeout refuses like
	// a send; reopening an existing one notifies nobody.
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

	// The recipient's visibility is decided INSIDE GetOrCreateDMChannelGated's transaction
	// and written once with the channel, leaving no post-hoc CloseDM to race a cancellation,
	// failure or in-flight accept.
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
	// GetUserDMChannels applies only db.StatusForViewer; add the "no live connection" half.
	for i := range dms {
		dms[i] = s.presentableDMChannelInfo(dms[i], userID)
	}
	return dms, nil
}

// CloseDMResult describes what closing a DM did, so the caller knows which events to send.
type CloseDMResult struct {
	Left                    bool
	ChannelDeleted          bool
	RemainingParticipantIDs []int64
	Rows                    []GroupEventRow
}

// CloseDM closes a DM for a user. For a 1:1 DM it only hides it from the caller's sidebar
// (the next message reopens it). For a group DM it is a leave: the caller leaves
// dm_participants and cannot reopen without being re-added. The result says which ran.
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
			return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
		}
		return nil, fmt.Errorf("%w: failed to leave group DM: %w", ErrInternal, err)
	}

	// The leave committed: the reads below must not fail on a client hang-up or survivors never hear of it.
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

// MaxGroupDMNameLen bounds the optional group name; matches the channel name cap (same sidebar row).
const MaxGroupDMNameLen = 100

// CreateGroupDMResult holds the result of creating a group DM.
type CreateGroupDMResult struct {
	Channel        *db.Channel
	Participants   []db.DMUser
	ParticipantIDs []int64
}

// CreateGroupDM creates a group DM between the caller and 2..8 others (db.MaxGroupDMParticipants
// total). Blocks are enforced both ways per recipient; a recipient with DMs from members
// off who does not trust the caller, or whom the caller holds an unaccepted request to, is
// refused the same way. Creation-time only by design: silently dropping one member's
// messages for another would make the conversation lie to everybody (so a member who later
// turns DMs off stays). Always creates a new channel.
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

	// Bound the raw bytes before cleanText (see cleanTextBounded in user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	// The same checks an add runs, so they cannot drift. The send-time gate
	// (RequireDMReachable) skips groups, so this is the only check: two mutually-blocked
	// recipients must not share a group even if neither blocked the creator.
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

	// Everything is committed, so this read must not turn a persisted group into a reported
	// failure (uncancellable; other failures are logged). Groups are duplicate-by-design, so a
	// reported failure would invite a retry creating a second group.
	participants, err := s.st.GetDMParticipants(context.WithoutCancel(ctx), ch.ID, userID)
	if err != nil {
		slog.Error("DMService.CreateGroupDM: failed to read participants after commit", "err", err, "channel_id", ch.ID)
		participants = nil
	}
	for i := range participants {
		participants[i] = s.presentableDMUser(participants[i], userID)
	}

	return &CreateGroupDMResult{
		Channel:        ch,
		Participants:   participants,
		ParticipantIDs: participantIDs,
	}, nil
}

// DMSummaryFor returns one DM's payload as viewerID sees it (group name, other
// participants, group flag). Every push of a DM's membership goes through it so events
// match GET /dms and `ready`. Membership is checked here, not by callers.
func (s *DMService) DMSummaryFor(ctx context.Context, viewerID, channelID int64) (db.DMChannelInfo, error) {
	ok, err := s.st.IsDMParticipant(ctx, viewerID, channelID)
	if err != nil || !ok {
		return db.DMChannelInfo{}, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	participants, err := s.st.GetDMParticipants(ctx, channelID, viewerID)
	if err != nil {
		return db.DMChannelInfo{}, fmt.Errorf("%w: failed to read DM participants: %w", ErrInternal, err)
	}
	ch, err := lookupChannel(ctx, s.st, channelID)
	if err != nil {
		return db.DMChannelInfo{}, err
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
	return s.presentableDMChannelInfo(db.NewDMChannelInfo(channelID, ch.Name, isGroup, ownerID, iconID, participants, viewerID), viewerID), nil
}
