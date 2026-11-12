package admin_test

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── 4.1: Channel CRUD broadcast tests ───────────────────────────────────────

// mockHub records which broadcast methods were called and with what arguments.
type mockHub struct {
	restartCalls        []restartCall
	channelCreates      []*db.Channel
	channelUpdates      []*db.Channel
	categoryBroadcasts  [][]db.ChannelCategory
	channelDeleteIDs    []int64
	memberBanIDs        []int64
	visibilityRefreshes []*db.Channel
	// roleRefreshes records every EnqueueRoleRefresh call (WP 4.4b): the one
	// call a role mutation makes, which replaced the RefreshAllChannelVisibility
	// count and the per-user member_update calls.
	roleRefreshes []ws.RoleRefresh
	// onEnqueue, when set, runs inside EnqueueRoleRefresh (ordering probes).
	onEnqueue       func(r ws.RoleRefresh)
	revokedIDs      []int64
	rolesUpdates    [][]*db.Role
	clientCount     int
	bulkDeletes     []bulkDeleteCall
	voiceCleanupIDs []int64
	// onVoiceCleanup lets a test observe DB state at cleanup time (ordering
	// vs. the channel-delete cascade).
	onVoiceCleanup func(channelID int64)
	// uploadPolicyBroadcasts counts BroadcastUploadPolicy calls.
	uploadPolicyBroadcasts int
	// gameActivityPolicies records every ApplyGameActivityPolicy call.
	gameActivityPolicies []bool
	// videoBitrateCaps records every ApplyVideoBitrateCap call.
	videoBitrateCaps []int
}

type bulkDeleteCall struct {
	channelID  int64
	messageIDs []int64
}

type restartCall struct {
	reason       ws.RestartReason
	delaySeconds int
}

func (m *mockHub) BroadcastServerRestart(reason ws.RestartReason, delaySeconds int) {
	m.restartCalls = append(m.restartCalls, restartCall{reason, delaySeconds})
}

func (m *mockHub) BroadcastChannelCreate(ch *db.Channel) {
	m.channelCreates = append(m.channelCreates, ch)
}

func (m *mockHub) BroadcastChannelUpdate(ch *db.Channel) {
	m.channelUpdates = append(m.channelUpdates, ch)
}

func (m *mockHub) BroadcastChannelCategories(cats []db.ChannelCategory) {
	m.categoryBroadcasts = append(m.categoryBroadcasts, cats)
}

func (m *mockHub) BroadcastChannelDelete(channelID int64) {
	m.channelDeleteIDs = append(m.channelDeleteIDs, channelID)
}

func (m *mockHub) CleanupVoiceForChannel(channelID int64) {
	m.voiceCleanupIDs = append(m.voiceCleanupIDs, channelID)
	if m.onVoiceCleanup != nil {
		m.onVoiceCleanup(channelID)
	}
}

func (m *mockHub) BroadcastMemberBan(userID int64) {
	m.memberBanIDs = append(m.memberBanIDs, userID)
}

func (m *mockHub) BroadcastChatBulkDeleted(channelID int64, messageIDs []int64) {
	m.bulkDeletes = append(m.bulkDeletes, bulkDeleteCall{channelID, messageIDs})
}

func (m *mockHub) RevokeUnreadableChannels(userID int64) {
	m.revokedIDs = append(m.revokedIDs, userID)
}

// RoleChanged, ChannelAudienceChanged and RevokeUnreadable make mockHub a
// service.PermissionChangeNotifier, recording through the same fields the
// handlers' direct hub calls used to fill.
func (m *mockHub) RoleChanged(f service.RoleFanout) {
	m.EnqueueRoleRefresh(ws.RoleRefresh{
		Visibility: f.Visibility, AllConnected: f.AllConnected,
		MemberUpdate: f.MemberUpdate, Roles: f.Roles,
	})
}

func (m *mockHub) ChannelAudienceChanged(ch *db.Channel) { m.RefreshChannelVisibility(ch) }

func (m *mockHub) RevokeUnreadable(userID int64) { m.RevokeUnreadableChannels(userID) }

func (m *mockHub) EnqueueRoleRefresh(r ws.RoleRefresh) {
	m.roleRefreshes = append(m.roleRefreshes, r)
	if m.onEnqueue != nil {
		m.onEnqueue(r)
	}
}

// visibilityEnqueues counts the enqueues that ask for a visibility refresh of
// some user (or of every connected user): what allVisibilityRefreshes counted.
func (m *mockHub) visibilityEnqueues() int {
	n := 0
	for _, r := range m.roleRefreshes {
		if len(r.Visibility) > 0 || r.AllConnected {
			n++
		}
	}
	return n
}

// rolesEnqueues counts the enqueues that ask for a roles_update.
func (m *mockHub) rolesEnqueues() int {
	n := 0
	for _, r := range m.roleRefreshes {
		if r.Roles {
			n++
		}
	}
	return n
}

// memberUpdateIDs lists every user an enqueue asked a member_update for.
func (m *mockHub) memberUpdateIDs() []int64 {
	var ids []int64
	for _, r := range m.roleRefreshes {
		ids = append(ids, r.MemberUpdate...)
	}
	return ids
}

func (m *mockHub) RefreshChannelVisibility(ch *db.Channel) {
	m.visibilityRefreshes = append(m.visibilityRefreshes, ch)
}

func (m *mockHub) BroadcastRolesUpdate(roles []*db.Role) {
	m.rolesUpdates = append(m.rolesUpdates, roles)
}

func (m *mockHub) BroadcastUploadPolicy() {
	m.uploadPolicyBroadcasts++
}

func (m *mockHub) ApplyGameActivityPolicy(saved bool) {
	m.gameActivityPolicies = append(m.gameActivityPolicies, saved)
}

func (m *mockHub) ApplyVideoBitrateCap(savedKbps int) {
	m.videoBitrateCaps = append(m.videoBitrateCaps, savedKbps)
}

func (m *mockHub) UserCount() int {
	return m.clientCount
}
