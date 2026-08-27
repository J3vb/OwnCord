package admin

import "github.com/J3vb/OwnCord/Server/ws"

// OC-0058: handlePatchUser reaches BroadcastMemberUnban through a type
// assertion, which fails silently if *ws.Hub ever loses (or never had) the
// method. This compile-time check turns that silent miss into a build error.
// In-package (not admin_test) so it can see the unexported interface; a test
// file so production admin still depends only on HubBroadcaster.
var _ memberUnbanBroadcaster = (*ws.Hub)(nil)
