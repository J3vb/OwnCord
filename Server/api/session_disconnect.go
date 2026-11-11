package api

import "github.com/J3vb/OwnCord/Server/ws"

// SessionDisconnector is the hub's half of a session revoke: the live sockets those sessions authenticated
// must go too. Sign-out-everywhere drops the account's socket; a password change or single revoke drops it
// only if its own session was revoked. A ProfileBroadcaster that does not implement it skips the disconnect.
type SessionDisconnector interface {
	DisconnectRevokedUser(userID int64)
	DisconnectIfSessionRevoked(userID int64)
}

// The production hub must keep satisfying it: a renamed method would silently leave revoked devices connected
// until the sweep.
var _ SessionDisconnector = (*ws.Hub)(nil)

func disconnectIfSessionRevoked(broadcaster ProfileBroadcaster, userID int64) {
	if d, ok := broadcaster.(SessionDisconnector); ok {
		d.DisconnectIfSessionRevoked(userID)
	}
}
