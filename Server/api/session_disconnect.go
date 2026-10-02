package api

import "github.com/J3vb/OwnCord/Server/ws"

// SessionDisconnector is the hub's half of a session revoke: once the
// sessions are gone, the live sockets they authenticated must go too, or a
// device keeps its connection until the revoked-session sweep notices
// (Codex P1 on PR #1500). Sign-out-everywhere drops the account's socket
// outright; a password change or a single revoke keeps some session, so it
// drops the socket only if its own session was revoked. *ws.Hub implements
// it; a ProfileBroadcaster that does not (tests, a nil hub) simply skips the
// disconnect.
type SessionDisconnector interface {
	DisconnectRevokedUser(userID int64)
	DisconnectIfSessionRevoked(userID int64)
}

// The production hub must keep satisfying it: the assertion at the call site
// silently skips the disconnect when it stops matching, so a renamed method
// would leave revoked devices connected until the sweep — the bug PR #1500
// fixed — with nothing failing to say so.
var _ SessionDisconnector = (*ws.Hub)(nil)

// disconnectIfSessionRevoked asks the hub to drop userID's socket if the
// session it rode was just revoked.
func disconnectIfSessionRevoked(broadcaster ProfileBroadcaster, userID int64) {
	if d, ok := broadcaster.(SessionDisconnector); ok {
		d.DisconnectIfSessionRevoked(userID)
	}
}
