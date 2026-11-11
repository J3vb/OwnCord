package service

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// WelcomeChannelKey is the settings key naming the channel that greets each new member; a missing or blank
// row means welcome messages are off.
const WelcomeChannelKey = "welcome_channel_id"

// WelcomeStore is the slice of the database the welcome writer adds to Store (the insert of the welcome row);
// declared here so Store, whose size is pinned, does not grow.
type WelcomeStore interface {
	InsertWelcomeRow(ctx context.Context, channelID, userID int64, content string) (*db.WelcomeRow, error)
}

var _ WelcomeStore = (*db.DB)(nil)

// WelcomeResult is a committed welcome row with its author resolved, ready to fan out.
type WelcomeResult struct {
	Row        *db.WelcomeRow
	Author     *db.User
	AuthorRole string
}

// WelcomeNotifier delivers a committed welcome row to the readers of its channel (*ws.Hub). Called after the
// commit, holding no service lock.
type WelcomeNotifier interface {
	WelcomeRow(ctx context.Context, res *WelcomeResult)
}

type welcomeServiceStore interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetSetting(ctx context.Context, key string) (string, error)
}

// WelcomeService writes the line greeting a new member in the admin-picked channel. All best effort: a
// failure is logged and never reaches the registration or approval that triggered it.
type WelcomeService struct {
	st       welcomeServiceStore
	store    WelcomeStore
	notifier WelcomeNotifier
}

// NewWelcomeService returns nil when st cannot insert a welcome row (a test double); a nil *WelcomeService
// greets nobody.
func NewWelcomeService(st welcomeServiceStore) *WelcomeService {
	ws, ok := st.(WelcomeStore)
	if !ok {
		return nil
	}
	return &WelcomeService{st: st, store: ws}
}

// SetNotifier installs the live delivery, once by the composition root before the hub runs; without it the
// row is still stored and reaches clients through history.
func (s *WelcomeService) SetNotifier(n WelcomeNotifier) {
	if s != nil {
		s.notifier = n
	}
}

// WelcomeChannelID reads a stored WelcomeChannelKey value: the channel id, or 0 for unset, blank or damaged.
func WelcomeChannelID(stored string) int64 {
	id, err := strconv.ParseInt(strings.TrimSpace(stored), 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// welcomeTimeout bounds Greet, which runs on a context detached from the request.
const welcomeTimeout = 5 * time.Second

// Greet writes the welcome row for userID, who just became a usable member, and delivers it. With no channel
// picked, a gone, archived or non-text channel, or any store fault, nothing is written and a registration is
// never failed. It runs detached from ctx so a caller that dropped after the commit still gets its welcome.
func (s *WelcomeService) Greet(ctx context.Context, userID int64) {
	if s == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), welcomeTimeout)
	defer cancel()
	stored, err := s.st.GetSetting(ctx, WelcomeChannelKey)
	if err != nil {
		if !errors.Is(err, db.ErrNotFound) {
			slog.Warn("welcome row: setting lookup", "err", err, "user_id", userID)
		}
		return
	}
	channelID := WelcomeChannelID(stored)
	if channelID == 0 {
		return
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		if !errors.Is(err, db.ErrNotFound) {
			slog.Warn("welcome row: channel lookup", "err", err, "channel_id", channelID)
		}
		return
	}
	// The pointer can dangle (channel archived or removed since the admin picked it): write nothing rather than
	// into a read-only or missing room.
	if ch == nil || ch.Type != "text" || ch.Archived {
		return
	}
	author, err := s.st.GetUserByID(ctx, userID)
	if err != nil || author == nil {
		slog.Warn("welcome row: member lookup", "err", err, "user_id", userID)
		return
	}
	row, err := s.store.InsertWelcomeRow(ctx, ch.ID, author.ID, author.Username+" joined the server.")
	if err != nil {
		slog.Warn("welcome row: insert", "err", err, "user_id", userID, "channel_id", ch.ID)
		return
	}
	if s.notifier == nil {
		return
	}
	res := &WelcomeResult{Row: row, Author: author}
	if role, err := s.st.GetRoleByID(ctx, author.RoleID); err == nil && role != nil {
		res.AuthorRole = role.Name
	}
	s.notifier.WelcomeRow(ctx, res)
}

type channelGetter interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// validateWelcomeChannel is the PATCH rule for WelcomeChannelKey: blank clears it; anything else must be the
// id of an existing, non-archived text channel. Returns the canonical value to store.
func validateWelcomeChannel(ctx context.Context, st channelGetter, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	id := WelcomeChannelID(value)
	if id == 0 || strconv.FormatInt(id, 10) != value {
		return "", errors.New(WelcomeChannelKey + ": must be a channel id or empty")
	}
	ch, err := st.GetChannel(ctx, id)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return "", errors.New(WelcomeChannelKey + ": channel not found")
		}
		return "", errors.Join(ErrInternal, err)
	}
	if ch == nil {
		return "", errors.New(WelcomeChannelKey + ": channel not found")
	}
	if ch.Type != "text" {
		return "", errors.New(WelcomeChannelKey + ": must be a text channel")
	}
	if ch.Archived {
		return "", errors.New(WelcomeChannelKey + ": channel is archived")
	}
	return value, nil
}
