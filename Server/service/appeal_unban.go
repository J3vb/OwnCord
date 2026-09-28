package service

// AppealUnbanBroadcaster re-adds a lifted user to every connected roster.
// *ws.Hub implements it (BroadcastMemberUnban); the admin unban path already
// depends on the same method. Optional: a nil broadcaster is a no-op, so a
// test fixture without a hub still exercises the decision path.
type AppealUnbanBroadcaster interface {
	BroadcastMemberUnban(userID int64)
}

// SetUnbanBroadcaster installs the member-unban broadcaster.
func (s *AppealService) SetUnbanBroadcaster(b AppealUnbanBroadcaster) { s.unban = b }

// broadcastUnban re-adds a lifted user to every connected roster via the
// installed broadcaster (nil-safe).
func (s *AppealService) broadcastUnban(userID int64) {
	if s.unban != nil {
		s.unban.BroadcastMemberUnban(userID)
	}
}
