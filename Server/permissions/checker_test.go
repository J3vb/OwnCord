package permissions

import (
	"context"
	"errors"
	"testing"
)

// ─── Mock DB ────────────────────────────────────────────────────────────────

type mockDB struct {
	channelPerms   map[chanRoleKey]chanPerm
	dmParticipants map[dmKey]bool
	chanErr        error
	dmErr          error
}

type (
	chanRoleKey struct{ channelID, roleID int64 }
	chanPerm    struct{ allow, deny int64 }
	dmKey       struct{ userID, channelID int64 }
)

func newMockDB() *mockDB {
	return &mockDB{
		channelPerms:   make(map[chanRoleKey]chanPerm),
		dmParticipants: make(map[dmKey]bool),
	}
}

func (m *mockDB) GetChannelPermissions(_ context.Context, channelID, roleID int64) (int64, int64, error) {
	if m.chanErr != nil {
		return 0, 0, m.chanErr
	}
	key := chanRoleKey{channelID, roleID}
	p, ok := m.channelPerms[key]
	if !ok {
		return 0, 0, nil
	}
	return p.allow, p.deny, nil
}

func (m *mockDB) IsDMParticipant(_ context.Context, userID, channelID int64) (bool, error) {
	if m.dmErr != nil {
		return false, m.dmErr
	}
	return m.dmParticipants[dmKey{userID, channelID}], nil
}

// ─── HasChannelPerm tests ───────────────────────────────────────────────────

func TestHasChannelPerm(t *testing.T) {
	tests := []struct {
		name      string
		rolePerms int64
		roleID    int64
		channelID int64
		perm      int64
		overrides map[chanRoleKey]chanPerm
		chanErr   error
		want      bool
	}{
		{
			name:      "admin bypass returns true",
			rolePerms: Administrator | SendMessages,
			roleID:    1,
			channelID: 10,
			perm:      ManageChannels,
			want:      true,
		},
		{
			name:      "non-admin with allow override returns true",
			rolePerms: ReadMessages,
			roleID:    4,
			channelID: 10,
			perm:      SendMessages,
			overrides: map[chanRoleKey]chanPerm{
				{10, 4}: {allow: SendMessages, deny: 0},
			},
			want: true,
		},
		{
			name:      "non-admin with deny override returns false",
			rolePerms: ReadMessages | SendMessages,
			roleID:    4,
			channelID: 10,
			perm:      SendMessages,
			overrides: map[chanRoleKey]chanPerm{
				{10, 4}: {allow: 0, deny: SendMessages},
			},
			want: false,
		},
		{
			name:      "non-admin without override uses base perms",
			rolePerms: ReadMessages | SendMessages,
			roleID:    4,
			channelID: 10,
			perm:      SendMessages,
			want:      true,
		},
		{
			name:      "non-admin lacking base perm returns false",
			rolePerms: ReadMessages,
			roleID:    4,
			channelID: 10,
			perm:      SendMessages,
			want:      false,
		},
		{
			name:      "db error returns false",
			rolePerms: ReadMessages | SendMessages,
			roleID:    4,
			channelID: 10,
			perm:      SendMessages,
			chanErr:   errors.New("db error"),
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newMockDB()
			db.chanErr = tt.chanErr
			for k, v := range tt.overrides {
				db.channelPerms[k] = v
			}
			ck := NewChecker(db)

			got := ck.HasChannelPerm(context.Background(), tt.rolePerms, tt.roleID, tt.channelID, tt.perm)
			if got != tt.want {
				t.Errorf("HasChannelPerm() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ─── HasChannelPermBatch tests ──────────────────────────────────────────────

func TestHasChannelPermBatch(t *testing.T) {
	tests := []struct {
		name      string
		rolePerms int64
		overrides map[int64]ChannelOverride
		channelID int64
		perm      int64
		want      bool
	}{
		{
			name:      "admin bypass returns true",
			rolePerms: Administrator,
			channelID: 10,
			perm:      ManageChannels,
			overrides: map[int64]ChannelOverride{},
			want:      true,
		},
		{
			name:      "uses pre-fetched allow override",
			rolePerms: ReadMessages,
			channelID: 10,
			perm:      SendMessages,
			overrides: map[int64]ChannelOverride{
				10: {Allow: SendMessages, Deny: 0},
			},
			want: true,
		},
		{
			name:      "uses pre-fetched deny override",
			rolePerms: ReadMessages | SendMessages,
			channelID: 10,
			perm:      SendMessages,
			overrides: map[int64]ChannelOverride{
				10: {Allow: 0, Deny: SendMessages},
			},
			want: false,
		},
		{
			name:      "missing override uses base perms (zero-value)",
			rolePerms: ReadMessages | SendMessages,
			channelID: 99,
			perm:      SendMessages,
			overrides: map[int64]ChannelOverride{},
			want:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ck := NewChecker(newMockDB())
			got := ck.HasChannelPermBatch(tt.rolePerms, tt.overrides, tt.channelID, tt.perm)
			if got != tt.want {
				t.Errorf("HasChannelPermBatch() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ─── VisibleChannelIDs tests ────────────────────────────────────────────────

func TestVisibleChannelIDs(t *testing.T) {
	channels := []ChannelRef{
		{ID: 1, Type: "text"},
		{ID: 2, Type: "announcement"},
		{ID: 3, Type: "voice"},
		{ID: 4, Type: "dm"}, // always skipped
	}

	tests := []struct {
		name      string
		rolePerms int64
		overrides map[int64]ChannelOverride
		want      map[int64]bool
	}{
		{
			name:      "admin sees every non-dm channel",
			rolePerms: Administrator,
			overrides: nil,
			want:      map[int64]bool{1: true, 2: true, 3: true},
		},
		{
			name:      "base ReadMessages inherits to all non-dm channels",
			rolePerms: ReadMessages,
			overrides: nil,
			want:      map[int64]bool{1: true, 2: true, 3: true},
		},
		{
			name:      "deny override hides a single channel",
			rolePerms: ReadMessages,
			overrides: map[int64]ChannelOverride{2: {Deny: ReadMessages}},
			want:      map[int64]bool{1: true, 3: true},
		},
		{
			name:      "allow override grants read to a role that otherwise lacks it",
			rolePerms: 0,
			overrides: map[int64]ChannelOverride{3: {Allow: ReadMessages}},
			want:      map[int64]bool{3: true},
		},
		{
			name:      "nil/zero role with no overrides sees nothing",
			rolePerms: 0,
			overrides: nil,
			want:      map[int64]bool{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ck := NewChecker(newMockDB())
			got := ck.VisibleChannelIDs(tt.rolePerms, channels, tt.overrides)
			if got[4] {
				t.Errorf("dm channel 4 must never be visible, got %v", got)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("VisibleChannelIDs() = %v, want %v", got, tt.want)
			}
			for id := range tt.want {
				if !got[id] {
					t.Errorf("VisibleChannelIDs() missing channel %d; got %v", id, got)
				}
			}
		})
	}
}

// ─── RequireChannelAccess tests ─────────────────────────────────────────────

func TestRequireChannelAccess(t *testing.T) {
	tests := []struct {
		name        string
		userID      int64
		rolePerms   int64
		roleID      int64
		channelType string
		channelID   int64
		perm        int64
		dmOK        bool
		dmErr       error
		wantErr     error
	}{
		{
			name:        "DM channel - participant allowed",
			userID:      1,
			channelType: "dm",
			channelID:   100,
			dmOK:        true,
			wantErr:     nil,
		},
		{
			name:        "DM channel - non-participant denied",
			userID:      1,
			channelType: "dm",
			channelID:   100,
			dmOK:        false,
			wantErr:     ErrNotDMParticipant,
		},
		{
			name:        "DM channel - db error",
			userID:      1,
			channelType: "dm",
			channelID:   100,
			dmErr:       errors.New("connection lost"),
		},
		{
			name:        "regular channel - has perm",
			userID:      1,
			rolePerms:   ReadMessages | SendMessages,
			roleID:      4,
			channelType: "text",
			channelID:   10,
			perm:        SendMessages,
			wantErr:     nil,
		},
		{
			name:        "regular channel - lacks perm",
			userID:      1,
			rolePerms:   ReadMessages,
			roleID:      4,
			channelType: "text",
			channelID:   10,
			perm:        SendMessages,
			wantErr:     ErrPermissionDenied,
		},
		{
			name:        "DM checks participant not role",
			userID:      1,
			rolePerms:   0, // no permissions at all
			roleID:      0, // no role
			channelType: "dm",
			channelID:   100,
			dmOK:        true,
			wantErr:     nil,
		},
		{
			name:        "admin bypasses regular channel check",
			userID:      1,
			rolePerms:   Administrator,
			roleID:      1,
			channelType: "text",
			channelID:   10,
			perm:        ManageChannels | ManageRoles, // multi-bit
			wantErr:     nil,
		},
		{
			name:        "admin does NOT bypass DM participant check",
			userID:      1,
			rolePerms:   Administrator,
			roleID:      1,
			channelType: "dm",
			channelID:   100,
			dmOK:        false,
			wantErr:     ErrNotDMParticipant,
		},
		{
			name:        "voice channel uses role perms",
			userID:      1,
			rolePerms:   ReadMessages | ConnectVoice | SpeakVoice,
			roleID:      4,
			channelType: "voice",
			channelID:   20,
			perm:        ConnectVoice,
			wantErr:     nil,
		},
		{
			name:        "voice channel denied without perm",
			userID:      1,
			rolePerms:   ReadMessages | SendMessages,
			roleID:      4,
			channelType: "voice",
			channelID:   20,
			perm:        ConnectVoice,
			wantErr:     ErrPermissionDenied,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := newMockDB()
			db.dmErr = tt.dmErr
			if tt.dmOK {
				db.dmParticipants[dmKey{tt.userID, tt.channelID}] = true
			}
			ck := NewChecker(db)

			err := ck.RequireChannelAccess(context.Background(), tt.userID, tt.rolePerms, tt.roleID, tt.channelType, tt.channelID, tt.perm)

			if tt.dmErr != nil {
				// Expect wrapped error.
				if err == nil {
					t.Fatal("RequireChannelAccess() = nil, want error")
				}
				if !errors.Is(err, tt.dmErr) {
					t.Errorf("RequireChannelAccess() error does not wrap dmErr: got %v", err)
				}
				return
			}

			if tt.wantErr == nil {
				if err != nil {
					t.Errorf("RequireChannelAccess() unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Errorf("RequireChannelAccess() = nil, want %v", tt.wantErr)
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("RequireChannelAccess() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
