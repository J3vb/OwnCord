package admin

import (
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// OC-0058: handlePatchUser reaches BroadcastMemberUnban through a type
// assertion, which fails silently if *ws.Hub ever loses (or never had) the
// method. This compile-time check turns that silent miss into a build error.
// In-package (not admin_test) so it can see the unexported interface; a test
// file so production admin still depends only on HubBroadcaster.
var _ memberUnbanBroadcaster = (*ws.Hub)(nil)

// The same shape of check for the support-health counters: collectSupportHealth
// reads every field through an assertion on the unexported interface, so a
// renamed hub method would leave the health panel reporting no voice sessions,
// drops or backpressure and nothing would fail.
var _ supportHubMetrics = (*ws.Hub)(nil)

// And for the disconnect capability the service layer asserts: api and service
// each declare their own copy, so this pins the production hub to one of them
// from a package that may import both.
var _ service.SessionDisconnector = (*ws.Hub)(nil)
