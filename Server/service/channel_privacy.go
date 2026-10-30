package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ChannelPrivacyStore is the reads the channel-level private flag makes.
type ChannelPrivacyStore interface {
	GetDefaultRole(ctx context.Context) (*db.Role, error)
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetAllChannelPermissionsForRole(ctx context.Context, roleID int64) (map[int64]db.ChannelOverride, error)
}

// ChannelPrivacyService answers whether a guild channel is private: the default
// (is_default) role cannot READ_MESSAGES there once the channel's override for
// that role is applied (permissions.IsChannelPrivate). The verdict is
// channel-level, identical for every viewer.
type ChannelPrivacyService struct {
	st ChannelPrivacyStore
}

// NewChannelPrivacyService creates a ChannelPrivacyService.
func NewChannelPrivacyService(st ChannelPrivacyStore) *ChannelPrivacyService {
	return &ChannelPrivacyService{st: st}
}

// ChannelPrivacySnapshot is the default role's base permissions and its
// override on every channel, read together. The zero value (no default role)
// marks nothing private.
type ChannelPrivacySnapshot struct {
	defaultPerms int64
	hasDefault   bool
	overrides    map[int64]db.ChannelOverride
}

// PrivateOf reports whether the channel row is private in this snapshot; a thread
// is judged on its parent's override. It is the only exported verdict: the snapshot
// keys overrides by parent and ordinary channel ids, so a bare id could be a thread
// and be judged public.
func (s ChannelPrivacySnapshot) PrivateOf(ch *db.Channel) bool {
	return s.private(ch.AuthorityID())
}

// private is the verdict for a parent or ordinary channel id. A channel without
// an override row is judged on the role's base permissions; one deleted after
// the snapshot was read is simply never asked about.
func (s ChannelPrivacySnapshot) private(channelID int64) bool {
	if !s.hasDefault {
		return false
	}
	o := s.overrides[channelID]
	return permissions.IsChannelPrivate(s.defaultPerms, permissions.ChannelOverride{Allow: o.Allow, Deny: o.Deny})
}

// Snapshot reads the default role and its overrides on every channel: two
// reads however many channels there are. No default role is not an error.
func (s *ChannelPrivacyService) Snapshot(ctx context.Context) (ChannelPrivacySnapshot, error) {
	role, err := s.st.GetDefaultRole(ctx)
	if err != nil {
		return ChannelPrivacySnapshot{}, fmt.Errorf("channel privacy default role: %w", err)
	}
	if role == nil {
		return ChannelPrivacySnapshot{}, nil
	}
	overrides, err := s.st.GetAllChannelPermissionsForRole(ctx, role.ID)
	if err != nil {
		return ChannelPrivacySnapshot{}, fmt.Errorf("channel privacy overrides: %w", err)
	}
	return ChannelPrivacySnapshot{defaultPerms: role.Permissions, hasDefault: true, overrides: overrides}, nil
}

// ChannelIsPrivate answers for one channel with two small reads: the default
// role, then its override there. No default role is (false, nil). channelID is
// a parent or ordinary channel id; a thread id has no override row of its own.
func (s *ChannelPrivacyService) ChannelIsPrivate(ctx context.Context, channelID int64) (bool, error) {
	role, err := s.st.GetDefaultRole(ctx)
	if err != nil {
		return false, fmt.Errorf("channel privacy default role: %w", err)
	}
	if role == nil {
		return false, nil
	}
	allow, deny, err := s.st.GetChannelPermissions(ctx, channelID, role.ID)
	if err != nil {
		return false, fmt.Errorf("channel privacy override: %w", err)
	}
	return permissions.IsChannelPrivate(role.Permissions, permissions.ChannelOverride{Allow: allow, Deny: deny}), nil
}
