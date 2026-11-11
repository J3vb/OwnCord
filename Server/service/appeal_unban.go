package service

// AppealUnbanBroadcaster re-adds a lifted user to every connected roster (*ws.Hub). Optional:
// nil is a no-op.
type AppealUnbanBroadcaster interface {
	BroadcastMemberUnban(userID int64)
}

// SetUnbanBroadcaster installs the member-unban broadcaster.
func (s *AppealService) SetUnbanBroadcaster(b AppealUnbanBroadcaster) { s.unban = b }

func (s *AppealService) broadcastUnban(userID int64) {
	if s.unban != nil {
		s.unban.BroadcastMemberUnban(userID)
	}
}
