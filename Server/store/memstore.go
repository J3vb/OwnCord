package store

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	"github.com/owncord/server/db"
)

// compile-time interface check
var _ Store = (*MemStore)(nil)

// MemStore is a lightweight in-memory Store implementation for testing.
// Only the methods needed by service-layer tests are implemented;
// everything else panics with a descriptive message.
type MemStore struct {
	mu sync.Mutex

	// auto-increment counters
	nextMsgID     int64
	nextChannelID int64

	channels map[int64]*db.Channel
	messages map[int64]*db.Message
	users    map[int64]*db.User
	roles    map[int64]*db.Role
	// userID -> roleID
	userRoles map[int64]int64
	// roleID -> channelID -> override
	channelOverrides map[int64]map[int64]db.ChannelOverride
	// messageID -> userID -> emoji -> bool
	reactions map[int64]map[int64]map[string]bool
	// channelID -> set of participant userIDs
	dmParticipants map[int64]map[int64]bool
	// blockerID -> blockedID -> bool (bidirectional checked via IsEitherBlocked)
	blocks map[int64]map[int64]bool
	// userID -> channelID -> lastReadMessageID
	readStates map[int64]map[int64]int64

	// Phase B Step 7 / Phase C Step 9 — events + plugin KV. Lazily initialised
	// via ensureEvents() so existing tests that constructed a bare MemStore
	// without these fields keep working.
	eventsOnce sync.Once
	eventStore *memEventStore
}

// NewMemStore creates an empty MemStore ready for use.
func NewMemStore() *MemStore {
	return &MemStore{
		channels:         make(map[int64]*db.Channel),
		messages:         make(map[int64]*db.Message),
		users:            make(map[int64]*db.User),
		roles:            make(map[int64]*db.Role),
		userRoles:        make(map[int64]int64),
		channelOverrides: make(map[int64]map[int64]db.ChannelOverride),
		reactions:        make(map[int64]map[int64]map[string]bool),
		dmParticipants:   make(map[int64]map[int64]bool),
		blocks:           make(map[int64]map[int64]bool),
		readStates:       make(map[int64]map[int64]int64),
	}
}

// ---------- helpers for test setup ----------

// SeedChannel inserts a channel directly (for test setup).
func (m *MemStore) SeedChannel(ch *db.Channel) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.channels[ch.ID] = ch
	if ch.ID >= m.nextChannelID {
		m.nextChannelID = ch.ID + 1
	}
}

// SeedUser inserts a user directly (for test setup).
func (m *MemStore) SeedUser(u *db.User) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.users[u.ID] = u
}

// SeedRole inserts a role directly (for test setup).
func (m *MemStore) SeedRole(r *db.Role) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roles[r.ID] = r
}

// SeedUserRole assigns a role to a user (for test setup).
func (m *MemStore) SeedUserRole(userID, roleID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.userRoles[userID] = roleID
}

// SeedChannelOverride sets a channel permission override for a role (for test setup).
func (m *MemStore) SeedChannelOverride(roleID, channelID int64, allow, deny int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.channelOverrides[roleID] == nil {
		m.channelOverrides[roleID] = make(map[int64]db.ChannelOverride)
	}
	m.channelOverrides[roleID][channelID] = db.ChannelOverride{Allow: allow, Deny: deny}
}

// SeedDMParticipant adds a user as a DM participant in a channel (for test setup).
func (m *MemStore) SeedDMParticipant(channelID, userID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dmParticipants[channelID] == nil {
		m.dmParticipants[channelID] = make(map[int64]bool)
	}
	m.dmParticipants[channelID][userID] = true
}

// SeedBlock records a block relationship (for test setup).
func (m *MemStore) SeedBlock(blockerID, blockedID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocks[blockerID] == nil {
		m.blocks[blockerID] = make(map[int64]bool)
	}
	m.blocks[blockerID][blockedID] = true
}

// ---------- Store interface: top-level ----------

func (m *MemStore) Close() error                                              { return nil }
func (m *MemStore) SQLDb() *sql.DB                                            { return nil }
func (m *MemStore) WithTx(_ context.Context, fn func(Store) error) error      { return fn(m) }

// ---------- MessageStore ----------

func (m *MemStore) CreateMessage(channelID, userID int64, content string, replyTo *int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextMsgID++
	id := m.nextMsgID
	m.messages[id] = &db.Message{
		ID:        id,
		ChannelID: channelID,
		UserID:    userID,
		Content:   content,
		ReplyTo:   replyTo,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	return id, nil
}

func (m *MemStore) GetMessage(id int64) (*db.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[id]
	if !ok {
		return nil, fmt.Errorf("message %d not found", id)
	}
	// Return a copy to avoid aliasing.
	cp := *msg
	return &cp, nil
}

func (m *MemStore) GetMessages(_ int64, _ int64, _ int) ([]db.MessageWithUser, error) {
	panic("memstore: not implemented: GetMessages")
}

func (m *MemStore) GetMessagesForAPI(_ int64, _ int64, _ int, _ int64) ([]db.MessageAPIResponse, error) {
	return []db.MessageAPIResponse{}, nil
}

func (m *MemStore) EditMessage(id, userID int64, content string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[id]
	if !ok {
		return fmt.Errorf("message %d not found", id)
	}
	if msg.UserID != userID {
		return fmt.Errorf("not message owner")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	msg.Content = content
	msg.EditedAt = &now
	return nil
}

func (m *MemStore) DeleteMessage(id, userID int64, isMod bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[id]
	if !ok {
		return fmt.Errorf("message %d not found", id)
	}
	if !isMod && msg.UserID != userID {
		return fmt.Errorf("not message owner")
	}
	msg.Deleted = true
	return nil
}

func (m *MemStore) SearchMessages(_ string, _ *int64, _ int) ([]db.MessageSearchResult, error) {
	return []db.MessageSearchResult{}, nil
}

func (m *MemStore) SearchMessagesInChannels(_ string, _ []int64, _ int) ([]db.MessageSearchResult, error) {
	return []db.MessageSearchResult{}, nil
}

func (m *MemStore) GetPinnedMessages(_ int64, _ int64) ([]db.MessageAPIResponse, error) {
	return []db.MessageAPIResponse{}, nil
}

func (m *MemStore) SetMessagePinned(_ int64, _ bool) error { return nil }

func (m *MemStore) AddReaction(messageID, userID int64, emoji string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.messages[messageID]; !ok {
		return fmt.Errorf("message %d not found", messageID)
	}
	if m.reactions[messageID] == nil {
		m.reactions[messageID] = make(map[int64]map[string]bool)
	}
	if m.reactions[messageID][userID] == nil {
		m.reactions[messageID][userID] = make(map[string]bool)
	}
	if m.reactions[messageID][userID][emoji] {
		return fmt.Errorf("reaction already exists")
	}
	m.reactions[messageID][userID][emoji] = true
	return nil
}

func (m *MemStore) RemoveReaction(messageID, userID int64, emoji string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.reactions[messageID] == nil || m.reactions[messageID][userID] == nil || !m.reactions[messageID][userID][emoji] {
		return fmt.Errorf("reaction not found")
	}
	delete(m.reactions[messageID][userID], emoji)
	return nil
}

func (m *MemStore) GetReactions(_ int64) ([]db.ReactionCount, error) {
	return []db.ReactionCount{}, nil
}

func (m *MemStore) UpdateReadState(userID, channelID, lastReadMessageID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.readStates[userID] == nil {
		m.readStates[userID] = make(map[int64]int64)
	}
	m.readStates[userID][channelID] = lastReadMessageID
	return nil
}

func (m *MemStore) GetChannelUnreadCounts(_ int64) (map[int64]db.ChannelUnread, error) {
	return map[int64]db.ChannelUnread{}, nil
}

func (m *MemStore) GetLatestMessageID(channelID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var latest int64
	for _, msg := range m.messages {
		if msg.ChannelID == channelID && msg.ID > latest {
			latest = msg.ID
		}
	}
	return latest, nil
}

func (m *MemStore) LinkAttachmentsToMessage(_ int64, _ []string) (int64, error) {
	return 0, nil
}

func (m *MemStore) GetAttachmentsByMessageIDs(_ []int64) (map[int64][]db.AttachmentInfo, error) {
	return map[int64][]db.AttachmentInfo{}, nil
}

// ---------- ChannelStore ----------

func (m *MemStore) ListChannels() ([]db.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]db.Channel, 0, len(m.channels))
	for _, ch := range m.channels {
		out = append(out, *ch)
	}
	return out, nil
}

func (m *MemStore) GetChannel(id int64) (*db.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch, ok := m.channels[id]
	if !ok {
		return nil, fmt.Errorf("channel %d not found", id)
	}
	cp := *ch
	return &cp, nil
}

func (m *MemStore) CreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextChannelID++
	id := m.nextChannelID
	m.channels[id] = &db.Channel{
		ID:        id,
		Name:      name,
		Type:      chanType,
		Category:  category,
		Topic:     topic,
		Position:  position,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	return id, nil
}

func (m *MemStore) UpdateChannel(_ int64, _, _ string, _ int) error {
	panic("memstore: not implemented: UpdateChannel")
}

func (m *MemStore) DeleteChannel(_ int64) error {
	panic("memstore: not implemented: DeleteChannel")
}

func (m *MemStore) SetChannelSlowMode(_ int64, _ int) error {
	panic("memstore: not implemented: SetChannelSlowMode")
}

func (m *MemStore) SetChannelVoiceMaxUsers(_ int64, _ int) error {
	panic("memstore: not implemented: SetChannelVoiceMaxUsers")
}

func (m *MemStore) GetChannelPermissions(channelID, roleID int64) (int64, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	overrides, ok := m.channelOverrides[roleID]
	if !ok {
		return 0, 0, nil
	}
	o, ok := overrides[channelID]
	if !ok {
		return 0, 0, nil
	}
	return o.Allow, o.Deny, nil
}

func (m *MemStore) GetAllChannelPermissionsForRole(roleID int64) (map[int64]db.ChannelOverride, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	overrides, ok := m.channelOverrides[roleID]
	if !ok {
		return map[int64]db.ChannelOverride{}, nil
	}
	// Copy map.
	out := make(map[int64]db.ChannelOverride, len(overrides))
	for k, v := range overrides {
		out[k] = v
	}
	return out, nil
}

func (m *MemStore) GetChannelTypes(_ []int64) (map[int64]string, error) {
	panic("memstore: not implemented: GetChannelTypes")
}

// ---------- UserStore ----------

func (m *MemStore) GetUserByID(id int64) (*db.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return nil, fmt.Errorf("user %d not found", id)
	}
	cp := *u
	return &cp, nil
}

func (m *MemStore) GetUserByUsername(_ string) (*db.User, error) {
	panic("memstore: not implemented: GetUserByUsername")
}

func (m *MemStore) CreateUser(_, _ string, _ int) (int64, error) {
	panic("memstore: not implemented: CreateUser")
}

func (m *MemStore) CreateOwnerIfEmpty(_, _ string, _ int) (int64, error) {
	panic("memstore: not implemented: CreateOwnerIfEmpty")
}

func (m *MemStore) CreateUserWithInvite(_, _ string, _ int, _ string) (int64, error) {
	panic("memstore: not implemented: CreateUserWithInvite")
}

func (m *MemStore) UpdateUserProfile(_ int64, _ string, _ *string) error {
	panic("memstore: not implemented: UpdateUserProfile")
}

func (m *MemStore) UpdateUserPassword(_ int64, _ string) error {
	panic("memstore: not implemented: UpdateUserPassword")
}

func (m *MemStore) UpdateUserStatus(id int64, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return fmt.Errorf("user %d not found", id)
	}
	u.Status = status
	return nil
}

func (m *MemStore) UpdateUserTOTPSecret(_ int64, _ *string) error {
	panic("memstore: not implemented: UpdateUserTOTPSecret")
}

func (m *MemStore) UpdateUserRole(_ int64, _ int64) error {
	panic("memstore: not implemented: UpdateUserRole")
}

func (m *MemStore) ResetAllUserStatuses() error {
	panic("memstore: not implemented: ResetAllUserStatuses")
}

func (m *MemStore) DeleteAccount(_ context.Context, _ int64) error {
	panic("memstore: not implemented: DeleteAccount")
}

func (m *MemStore) ListMembers() ([]db.MemberSummary, error) {
	panic("memstore: not implemented: ListMembers")
}

// ---------- SessionStore ----------

func (m *MemStore) CreateSession(_ int64, _, _, _ string) (int64, error) {
	panic("memstore: not implemented: CreateSession")
}

func (m *MemStore) GetSessionByTokenHash(_ string) (*db.Session, error) {
	panic("memstore: not implemented: GetSessionByTokenHash")
}

func (m *MemStore) GetSessionWithBanStatus(_ string) (*db.SessionWithBanStatus, error) {
	panic("memstore: not implemented: GetSessionWithBanStatus")
}

func (m *MemStore) DeleteSession(_ string) error {
	panic("memstore: not implemented: DeleteSession")
}

func (m *MemStore) DeleteOtherSessions(_ int64, _ int64) (int64, error) {
	panic("memstore: not implemented: DeleteOtherSessions")
}

func (m *MemStore) DeleteExpiredSessions() error {
	panic("memstore: not implemented: DeleteExpiredSessions")
}

func (m *MemStore) DeleteSessionByID(_ int64, _ int64) error {
	panic("memstore: not implemented: DeleteSessionByID")
}

func (m *MemStore) TouchSession(_ string) error {
	panic("memstore: not implemented: TouchSession")
}

func (m *MemStore) ListUserSessions(_ int64) ([]db.Session, error) {
	panic("memstore: not implemented: ListUserSessions")
}

func (m *MemStore) ForceLogoutUser(_ int64) error {
	panic("memstore: not implemented: ForceLogoutUser")
}

func (m *MemStore) GetUserSessions(_ int64) ([]db.Session, error) {
	panic("memstore: not implemented: GetUserSessions")
}

// ---------- RoleStore ----------

func (m *MemStore) GetRoleByID(id int64) (*db.Role, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.roles[id]
	if !ok {
		return nil, fmt.Errorf("role %d not found", id)
	}
	cp := *r
	return &cp, nil
}

func (m *MemStore) GetRoleForUser(userID int64) (*db.Role, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roleID, ok := m.userRoles[userID]
	if !ok {
		return nil, fmt.Errorf("no role for user %d", userID)
	}
	r, ok := m.roles[roleID]
	if !ok {
		return nil, fmt.Errorf("role %d not found", roleID)
	}
	cp := *r
	return &cp, nil
}

func (m *MemStore) GetUserWithRole(_ int64) (*db.User, *db.Role, error) {
	panic("memstore: not implemented: GetUserWithRole")
}

func (m *MemStore) ListRoles() ([]*db.Role, error) {
	panic("memstore: not implemented: ListRoles")
}

// ---------- InviteStore ----------

func (m *MemStore) CreateInvite(_ int64, _ int, _ *time.Time) (string, error) {
	panic("memstore: not implemented: CreateInvite")
}

func (m *MemStore) GetInvite(_ string) (*db.Invite, error) {
	panic("memstore: not implemented: GetInvite")
}

func (m *MemStore) ListInvites() ([]*db.Invite, error) {
	panic("memstore: not implemented: ListInvites")
}

func (m *MemStore) UseInviteAtomic(_ string) error {
	panic("memstore: not implemented: UseInviteAtomic")
}

func (m *MemStore) RevokeInvite(_ string) error {
	panic("memstore: not implemented: RevokeInvite")
}

// ---------- VoiceStore ----------

func (m *MemStore) JoinVoiceChannel(_ int64, _ int64) error {
	panic("memstore: not implemented: JoinVoiceChannel")
}

func (m *MemStore) JoinVoiceChannelIfCapacity(_ int64, _ int64, _ int) error {
	panic("memstore: not implemented: JoinVoiceChannelIfCapacity")
}

func (m *MemStore) LeaveVoiceChannel(_ int64) error {
	panic("memstore: not implemented: LeaveVoiceChannel")
}

func (m *MemStore) LeaveVoiceChannelIfMatch(_ int64, _ int64, _ string) (bool, error) {
	panic("memstore: not implemented: LeaveVoiceChannelIfMatch")
}

func (m *MemStore) GetVoiceState(_ int64) (*db.VoiceState, error) {
	panic("memstore: not implemented: GetVoiceState")
}

func (m *MemStore) GetChannelVoiceStates(_ int64) ([]db.VoiceState, error) {
	panic("memstore: not implemented: GetChannelVoiceStates")
}

func (m *MemStore) GetAllVoiceStates() ([]db.VoiceState, error) {
	panic("memstore: not implemented: GetAllVoiceStates")
}

func (m *MemStore) UpdateVoiceMute(_ int64, _ bool) error {
	panic("memstore: not implemented: UpdateVoiceMute")
}

func (m *MemStore) UpdateVoiceDeafen(_ int64, _ bool) error {
	panic("memstore: not implemented: UpdateVoiceDeafen")
}

func (m *MemStore) ClearVoiceState(_ int64) error {
	panic("memstore: not implemented: ClearVoiceState")
}

func (m *MemStore) ClearAllVoiceStates() error {
	panic("memstore: not implemented: ClearAllVoiceStates")
}

func (m *MemStore) CountActiveCameras(_ int64) (int, error) {
	panic("memstore: not implemented: CountActiveCameras")
}

func (m *MemStore) UpdateVoiceCamera(_ int64, _ bool) error {
	panic("memstore: not implemented: UpdateVoiceCamera")
}

func (m *MemStore) EnableCameraIfUnderLimit(_ int64, _ int64, _ int) (bool, error) {
	panic("memstore: not implemented: EnableCameraIfUnderLimit")
}

func (m *MemStore) UpdateVoiceScreenshare(_ int64, _ bool) error {
	panic("memstore: not implemented: UpdateVoiceScreenshare")
}

func (m *MemStore) CountChannelVoiceUsers(_ int64) (int, error) {
	panic("memstore: not implemented: CountChannelVoiceUsers")
}

// ---------- DMStore ----------

func (m *MemStore) GetOrCreateDMChannel(_ int64, _ int64) (*db.Channel, bool, error) {
	panic("memstore: not implemented: GetOrCreateDMChannel")
}

func (m *MemStore) GetUserDMChannels(_ int64) ([]db.DMChannelInfo, error) {
	return []db.DMChannelInfo{}, nil
}

func (m *MemStore) OpenDM(_, _ int64) error  { return nil }
func (m *MemStore) CloseDM(_, _ int64) error { return nil }

func (m *MemStore) IsDMParticipant(userID, channelID int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	participants, ok := m.dmParticipants[channelID]
	if !ok {
		return false, nil
	}
	return participants[userID], nil
}

func (m *MemStore) GetDMParticipantIDs(channelID int64) ([]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	participants, ok := m.dmParticipants[channelID]
	if !ok {
		return []int64{}, nil
	}
	ids := make([]int64, 0, len(participants))
	for id := range participants {
		ids = append(ids, id)
	}
	return ids, nil
}

func (m *MemStore) GetDMRecipient(_ int64, _ int64) (*db.User, error) {
	return nil, nil
}

// ---------- BlockStore ----------

func (m *MemStore) BlockUser(_, _ int64) error   { return nil }
func (m *MemStore) UnblockUser(_, _ int64) error { return nil }

func (m *MemStore) IsBlocked(blockerID, blockedID int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocks[blockerID] != nil && m.blocks[blockerID][blockedID] {
		return true, nil
	}
	return false, nil
}

func (m *MemStore) IsEitherBlocked(userA, userB int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocks[userA] != nil && m.blocks[userA][userB] {
		return true, nil
	}
	if m.blocks[userB] != nil && m.blocks[userB][userA] {
		return true, nil
	}
	return false, nil
}

func (m *MemStore) ListBlockedUsers(_ int64) ([]int64, error) {
	return []int64{}, nil
}

// ---------- AttachmentStore ----------

func (m *MemStore) CreateAttachment(_ string, _ int64, _, _, _ string, _ int64, _, _ *int) error {
	panic("memstore: not implemented: CreateAttachment")
}

func (m *MemStore) GetAttachmentByID(_ string) (*db.Attachment, error) {
	panic("memstore: not implemented: GetAttachmentByID")
}

func (m *MemStore) GetAttachmentWithChannel(_ string) (*db.AttachmentAccess, error) {
	panic("memstore: not implemented: GetAttachmentWithChannel")
}

func (m *MemStore) DeleteOrphanedAttachments(_ string) ([]string, error) {
	panic("memstore: not implemented: DeleteOrphanedAttachments")
}

// ---------- AdminStore ----------

func (m *MemStore) UserCount() (int64, error) {
	panic("memstore: not implemented: UserCount")
}

func (m *MemStore) GetServerStats() (*db.ServerStats, error) {
	panic("memstore: not implemented: GetServerStats")
}

func (m *MemStore) ListAllUsers(_ int, _ int) ([]db.UserWithRole, error) {
	panic("memstore: not implemented: ListAllUsers")
}

func (m *MemStore) BanUser(_ int64, _ string, _ *time.Time) error {
	panic("memstore: not implemented: BanUser")
}

func (m *MemStore) UnbanUser(_ int64) error {
	panic("memstore: not implemented: UnbanUser")
}

func (m *MemStore) LogAudit(_ int64, _, _ string, _ int64, _ string) error {
	return nil
}

func (m *MemStore) GetAuditLog(_ int, _ int) ([]db.AuditEntry, error) {
	panic("memstore: not implemented: GetAuditLog")
}

func (m *MemStore) AdminCreateChannel(_, _, _, _ string, _ int) (int64, error) {
	panic("memstore: not implemented: AdminCreateChannel")
}

func (m *MemStore) AdminUpdateChannel(_ int64, _, _ string, _, _ int, _ bool) error {
	panic("memstore: not implemented: AdminUpdateChannel")
}

func (m *MemStore) AdminDeleteChannel(_ int64) error {
	panic("memstore: not implemented: AdminDeleteChannel")
}

func (m *MemStore) BackupTo(_ string) error {
	panic("memstore: not implemented: BackupTo")
}

func (m *MemStore) BackupToSafe(_, _ string) error {
	panic("memstore: not implemented: BackupToSafe")
}

func (m *MemStore) CountUsersWithoutTOTP() (int, error) {
	panic("memstore: not implemented: CountUsersWithoutTOTP")
}

// ---------- SettingsStore ----------

func (m *MemStore) GetSetting(_ string) (string, error) {
	panic("memstore: not implemented: GetSetting")
}

func (m *MemStore) SetSetting(_, _ string) error {
	panic("memstore: not implemented: SetSetting")
}

func (m *MemStore) GetAllSettings() (map[string]string, error) {
	panic("memstore: not implemented: GetAllSettings")
}
