package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// DMService handles direct message channel operations.
type DMService struct {
	st store.Store
}

// NewDMService creates a DMService.
func NewDMService(st store.Store) *DMService {
	return &DMService{st: st}
}

// CreateDMResult holds the result of creating or fetching a DM channel.
type CreateDMResult struct {
	Channel   *db.Channel
	Created   bool
	Recipient *db.User
}

// CreateDM creates or retrieves a DM channel between two users.
// Validates that neither user has blocked the other.
func (s *DMService) CreateDM(userID, recipientID int64) (*CreateDMResult, error) {
	ctx, span := telemetry.GlobalTracer("service/dm").Start(context.Background(), "DMService.CreateDM",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("recipient_id", recipientID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "CreateDM"))
		span.End()
	}()

	if recipientID <= 0 {
		return nil, fmt.Errorf("%w: recipient_id must be positive", ErrBadRequest)
	}
	if userID == recipientID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", ErrBadRequest)
	}

	recipient, err := s.st.GetUserByID(recipientID)
	if err != nil || recipient == nil {
		return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
	}

	blocked, err := s.st.IsEitherBlocked(userID, recipientID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check block status", ErrInternal)
	}
	if blocked {
		return nil, fmt.Errorf("%w: cannot create DM — user is blocked", ErrForbidden)
	}

	ch, created, err := s.st.GetOrCreateDMChannel(userID, recipientID)
	if err != nil {
		slog.Error("DMService.CreateDM", "err", err)
		return nil, fmt.Errorf("%w: failed to create DM channel", ErrInternal)
	}

	return &CreateDMResult{
		Channel:   ch,
		Created:   created,
		Recipient: recipient,
	}, nil
}

// ListDMs returns all open DM channels for a user.
func (s *DMService) ListDMs(userID int64) ([]db.DMChannelInfo, error) {
	dms, err := s.st.GetUserDMChannels(userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list DMs", ErrInternal)
	}
	return dms, nil
}

// CloseDM closes a DM channel for a user.
func (s *DMService) CloseDM(userID, channelID int64) error {
	if channelID <= 0 {
		return fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(userID, channelID)
	if err != nil || !ok {
		return fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
	}

	if err := s.st.CloseDM(userID, channelID); err != nil {
		return fmt.Errorf("%w: failed to close DM", ErrInternal)
	}

	slog.Debug("DM closed", "user_id", userID, "channel_id", channelID)
	return nil
}
